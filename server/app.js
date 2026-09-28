'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Store, newId } = require('./store');
const { openDatabase } = require('./db');
const { fillBoxes, estimateOdds, isAvailable, weightedPick } = require('./draw');
const { attachRealtime } = require('./realtime');
const { RoomService } = require('./rooms/service');
const games = require('./games');
const { HttpError } = require('./httpError');
const { str, int } = require('./validate');
const { parseCookies } = require('./cookies');
const { claimCode } = require('./codes');
const { publicPrize } = require('./prizeView');
const { clientIp, createFailureLimiter } = require('./ratelimit');
const { hashPassword, verifyPassword } = require('./auth');

const ROUND_TTL_MS = 30 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;
const MIN_PASSWORD_LEN = 8;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function validatePrize(body, existing = {}) {
  const merged = { ...existing, ...body };
  const color = str(merged.color || '#8b5cf6', 'Color', { max: 7 });
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'Color must be a hex value like #8b5cf6');
  const image = merged.image ? str(merged.image, 'Image', { max: 500 }) : null;
  if (image && !/^(\/uploads\/[\w.-]+|https?:\/\/\S+)$/.test(image)) {
    throw new HttpError(400, 'Image must be an uploaded file or an http(s) URL');
  }
  return {
    name: str(merged.name, 'Name', { max: 60, required: true }),
    description: str(merged.description, 'Description', { max: 200 }),
    emoji: str(merged.emoji || '🎁', 'Emoji', { max: 16 }),
    image,
    imageBorder: merged.imageBorder !== false,
    color,
    weight: int(merged.weight ?? 1, 'Weight', 0, 100000),
    stock: merged.stock === null || merged.stock === '' || merged.stock === undefined
      ? null
      : int(merged.stock, 'Stock', 0, 1000000),
    active: merged.active !== false,
    winning: merged.winning !== false,
  };
}

function requirePassword(pw, field = 'Password') {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LEN) {
    throw new HttpError(400, `${field} must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  return pw;
}

const authUserView = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const adminUserView = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled, createdAt: u.createdAt, roomCount: u.roomCount ?? 0 });

// ---------- app ----------

/**
 * Build the Express app. The database connects lazily on the first request,
 * which suits serverless hosts as well as a long-running server.
 *
 * Options: `db` (an already-open handle, used by tests) or `databaseUrl` / `dataDir`.
 */
function createApp({ db, databaseUrl, dataDir, adminPassword, adminEmail, countdownMsOverride }) {
  let store;
  let roomService;
  let io = null;
  let pendingIo = null; // attach() may run before roomService exists (server/index.js calls it before `ready`)
  let connecting = null;
  // Connect once; if it fails (e.g. the database is briefly unreachable), the next request retries.
  const connect = () => {
    connecting ||= (async () => {
      const s = new Store(db || (await openDatabase({ databaseUrl, dataDir })));
      await s.migrate({ adminPassword, adminEmail });
      store = s;
      roomService = new RoomService({ store: s, games, countdownMsOverride });
      await roomService.ready;
      if (pendingIo) roomService.setIo(pendingIo);
      return s;
    })().catch((err) => {
      connecting = null;
      console.error('Database setup failed:', err.message);
      throw err;
    });
    return connecting;
  };
  const ready = connect();
  ready.catch(() => {}); // reported above; requests will retry

  const loginLimiter = createFailureLimiter({ max: MAX_LOGIN_FAILURES, windowMs: LOGIN_FAILURE_WINDOW_MS });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const cookie = (req, name, value, opts) => {
    const secure = req.secure ? '; Secure' : '';
    return `${name}=${value}; ${opts}${secure}`;
  };

  app.use('/api', express.json({ limit: '4mb' }));

  // A liveness probe that never touches the database, so it stays fast even if the DB is down.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Wait for the database before touching any dynamic route.
  const needsDb = async (req, res, next) => {
    await connect();
    next();
  };
  app.use(['/api', '/uploads'], needsDb);

  // Every visitor gets an anonymous id cookie so plays-per-visitor can be enforced.
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    let visitor = req.cookies.mb_visitor;
    if (!visitor || !/^[\w-]{36}$/.test(visitor)) {
      visitor = newId();
      res.append('Set-Cookie', cookie(req, 'mb_visitor', visitor, 'Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly'));
    }
    req.visitor = visitor;
    next();
  });

  const playsLeft = async (room, visitor, q) => {
    const max = room.settings.maxPlaysPerVisitor;
    return max > 0 ? Math.max(0, max - (await store.playsBy(visitor, room.id, q))) : null;
  };

  const sessionUser = async (req) => {
    const token = req.cookies.mb_session;
    return token ? store.getSessionUser(token) : null;
  };
  const requireSessionUser = async (req) => {
    const user = await sessionUser(req);
    if (!user) throw new HttpError(401, 'Please sign in');
    return user;
  };

  // ----- auth -----

  app.post('/api/auth/login', async (req, res) => {
    const ip = clientIp(req);
    if (!loginLimiter.allowed(ip)) throw new HttpError(429, 'Too many attempts — wait a few minutes');
    const email = str(req.body?.email, 'Email', { max: 200, required: true }).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    const user = await store.getUserByEmail(email);
    const ok = Boolean(user) && !user.disabled && await verifyPassword(password, user.passwordHash);
    if (!ok) {
      loginLimiter.recordFailure(ip);
      throw new HttpError(401, 'Wrong email or password');
    }

    const token = crypto.randomBytes(32).toString('hex');
    await store.createUserSession(token, user.id, SESSION_TTL_MS);
    res.append('Set-Cookie', cookie(req, 'mb_session', token, `Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Strict; HttpOnly`));
    res.json({ user: authUserView(user) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (req.cookies.mb_session) await store.deleteUserSession(req.cookies.mb_session);
    res.append('Set-Cookie', cookie(req, 'mb_session', '', 'Path=/; Max-Age=0; SameSite=Strict; HttpOnly'));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', async (req, res) => {
    const user = await sessionUser(req);
    res.json(user ? { authenticated: true, user: authUserView(user) } : { authenticated: false });
  });

  app.put('/api/auth/password', async (req, res) => {
    const user = await requireSessionUser(req);
    const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    if (!(await verifyPassword(current, user.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
    const fresh = requirePassword(req.body?.newPassword, 'New password');
    await store.updateUser(user.id, { passwordHash: await hashPassword(fresh) });
    res.json({ ok: true });
  });

  // ----- public: rooms by code -----

  app.post('/api/rooms/lookup', async (req, res) => {
    res.json(await roomService.lookup(req.body?.code, clientIp(req)));
  });

  app.post('/api/rooms/join', async (req, res) => {
    const result = await roomService.join({
      code: req.body?.code,
      name: req.body?.name,
      visitor: req.visitor,
      ip: clientIp(req),
    });
    res.json(result);
  });

  app.post('/api/rooms/watch', async (req, res) => {
    res.json(await roomService.watch(req.body?.code, req.visitor, clientIp(req)));
  });

  app.get('/api/rooms/:code/config', async (req, res) => {
    const room = await roomService.resolveDefaultRoomByCode(req.params.code, clientIp(req));
    const prizes = await store.listPrizes(room.id);
    res.json({
      code: room.code,
      title: room.settings.title,
      subtitle: room.settings.subtitle,
      boxCount: room.boxCount,
      boxStyle: room.style,
      showPrizes: room.settings.showPrizes,
      playsLeft: await playsLeft(room, req.visitor),
      prizes: room.settings.showPrizes ? prizes.filter(isAvailable).map(publicPrize) : [],
    });
  });

  app.post('/api/rooms/:code/rounds', async (req, res) => {
    const room = await roomService.resolveDefaultRoomByCode(req.params.code, clientIp(req));
    const prizes = await store.listPrizes(room.id);
    if ((await playsLeft(room, req.visitor)) === 0) throw new HttpError(403, "You've used all your plays. Thanks for playing!");
    const boxes = fillBoxes(prizes, room.boxCount, room.settings.assignment);
    if (!boxes) throw new HttpError(409, 'All prizes have been claimed. Check back soon!');
    const roundId = await store.createRound({ roomId: room.id, visitor: req.visitor, boxes, ttlMs: ROUND_TTL_MS });
    res.status(201).json({ roundId, boxCount: boxes.length });
  });

  app.post('/api/rooms/:code/rounds/:id/pick', async (req, res) => {
    const room = await roomService.resolveDefaultRoomByCode(req.params.code, clientIp(req));
    const box = int(req.body?.box, 'Box', 0, 11);

    const result = await store.openRound({ roundId: req.params.id, roomId: room.id, visitor: req.visitor }, async (boxes, q) => {
      if (box >= boxes.length) throw new HttpError(400, `Box must be between 0 and ${boxes.length - 1}`);
      if ((await playsLeft(room, req.visitor, q)) === 0) {
        throw new HttpError(403, "You've used all your plays. Thanks for playing!");
      }

      // Take one unit of the box's prize. If it ran out since the round was dealt,
      // swap in something that is still available.
      let prize = await store.takePrize(q, room.id, boxes[box]);
      for (let attempt = 0; !prize && attempt < 5; attempt++) {
        const pool = (await store.listPrizes(room.id, q)).filter(isAvailable);
        if (pool.length === 0) throw new HttpError(409, 'All prizes have been claimed. Check back soon!');
        prize = await store.takePrize(q, room.id, weightedPick(pool).id);
      }
      if (!prize) throw new HttpError(409, 'Prizes are going fast — please try again!');
      boxes[box] = prize.id;

      const draw = await store.insertDraw(q, {
        code: prize.winning ? claimCode() : null,
        prizeId: prize.id,
        prizeName: prize.name,
        emoji: prize.emoji,
        visitor: req.visitor,
        roomId: room.id,
      });
      const all = new Map((await store.listPrizes(room.id, q)).map((p) => [p.id, p]));
      return {
        box,
        prize: publicPrize(prize),
        code: draw.code,
        boxes: boxes.map((id) => (all.has(id) ? publicPrize(all.get(id)) : null)),
        playsLeft: await playsLeft(room, req.visitor, q),
      };
    });

    if (!result) throw new HttpError(404, 'This round has expired. Shuffle again!');
    res.json(result);
  });

  // ----- admin: session gate -----

  app.use('/api/admin', async (req, res, next) => {
    req.user = await requireSessionUser(req);
    next();
  });

  const requireSuperadmin = (req, res, next) => {
    if (req.user.role !== 'superadmin') throw new HttpError(403, 'Super-admin only');
    next();
  };

  /** Fetch a room I own, or 404 — used by every /api/admin/rooms/:id/* route. */
  const ownedRoom = async (req) => {
    const room = await store.getOwnedRoom(req.user.id, req.params.id);
    if (!room) throw new HttpError(404, 'Room not found');
    return room;
  };

  // ----- admin: rooms -----

  app.post('/api/admin/rooms', async (req, res) => {
    res.status(201).json(await roomService.createRoom(req.user.id, req.body ?? {}));
  });

  app.get('/api/admin/rooms', async (req, res) => {
    res.json(await roomService.listRooms(req.user.id, req.query.include === 'closed'));
  });

  app.get('/api/admin/rooms/:id', async (req, res) => {
    res.json(await roomService.getRoomSummary(req.user.id, req.params.id));
  });

  app.put('/api/admin/rooms/:id', async (req, res) => {
    res.json(await roomService.updateRoom(req.user.id, req.params.id, req.body ?? {}));
  });

  app.delete('/api/admin/rooms/:id', async (req, res) => {
    await roomService.closeRoomForOwner(req.user.id, req.params.id);
    res.status(204).end();
  });

  // ----- admin: prizes (room-scoped) -----

  app.get('/api/admin/rooms/:id/prizes', async (req, res) => {
    const room = await ownedRoom(req);
    const [prizes, won] = await Promise.all([store.listPrizes(room.id), store.wonCounts(room.id)]);
    res.json(prizes.map((p) => ({ ...p, won: won[p.id] || 0, available: isAvailable(p) })));
  });

  app.post('/api/admin/rooms/:id/prizes', async (req, res) => {
    const room = await ownedRoom(req);
    if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
    res.status(201).json(await store.createPrize(room.id, validatePrize(req.body ?? {})));
  });

  app.put('/api/admin/rooms/:id/prizes/:prizeId', async (req, res) => {
    const room = await ownedRoom(req);
    if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
    const existing = await store.getPrize(room.id, req.params.prizeId);
    if (!existing) throw new HttpError(404, 'Prize not found');
    res.json(await store.updatePrize(room.id, req.params.prizeId, validatePrize(req.body ?? {}, existing)));
  });

  app.delete('/api/admin/rooms/:id/prizes/:prizeId', async (req, res) => {
    const room = await ownedRoom(req);
    if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
    if (!(await store.deletePrize(room.id, req.params.prizeId))) throw new HttpError(404, 'Prize not found');
    res.status(204).end();
  });

  app.put('/api/admin/rooms/:id/prizes-order', async (req, res) => {
    const room = await ownedRoom(req);
    if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw new HttpError(400, 'ids must be an array');
    await store.reorderPrizes(room.id, ids);
    res.json({ ok: true });
  });

  app.get('/api/admin/rooms/:id/odds', async (req, res) => {
    const room = await ownedRoom(req);
    const prizes = await store.listPrizes(room.id);
    res.json(estimateOdds(prizes, room.boxCount, room.settings.assignment));
  });

  // ----- admin: uploads (stored in the database, so no file storage is needed) -----

  app.post('/api/admin/uploads', async (req, res) => {
    const match = /^data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.dataUrl ?? '');
    const ext = match && IMAGE_TYPES[match[1]];
    if (!ext) throw new HttpError(400, 'Upload a PNG, JPG, WebP or GIF image');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Image must be 2 MB or smaller');
    const id = await store.saveImage(match[1], buffer, req.user.id);
    res.status(201).json({ url: `/uploads/${id}.${ext}` });
  });

  // ----- admin: draws (winners log, across my rooms incl. closed) -----

  app.get('/api/admin/draws', async (req, res) => {
    res.json(await store.listDraws(req.user.id, req.query.roomId || undefined));
  });

  app.patch('/api/admin/draws/:id', async (req, res) => {
    const draw = await store.setRedeemed(req.user.id, req.params.id, Boolean(req.body?.redeemed));
    if (!draw) throw new HttpError(404, 'Draw not found');
    res.json(draw);
  });

  app.delete('/api/admin/draws', async (req, res) => {
    await store.clearDraws(req.user.id, req.query.roomId || undefined);
    res.status(204).end();
  });

  app.get('/api/admin/draws.csv', async (req, res) => {
    // Neutralize spreadsheet formula injection: a cell that opens with =, +, -, @, a tab or a CR
    // (e.g. a prize name or player display name someone crafted as `=cmd(...)`) gets a leading `'`
    // so Excel/Sheets shows it as literal text instead of evaluating it as a formula.
    const esc = (v) => {
      let s = String(v instanceof Date ? v.toISOString() : v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = [['Date', 'Claim code', 'Prize', 'Redeemed', 'Redeemed at', 'Player', 'Room']];
    for (const d of await store.listDraws(req.user.id, req.query.roomId || undefined)) {
      rows.push([d.createdAt, d.code, d.prizeName, d.redeemed ? 'yes' : 'no', d.redeemedAt, d.playerName, d.roomCode]);
    }
    res.type('text/csv').attachment('mystery-box-draws.csv').send(rows.map((r) => r.map(esc).join(',')).join('\n'));
  });

  // ----- admin: users (superadmin only) -----

  app.get('/api/admin/users', requireSuperadmin, async (req, res) => {
    res.json((await store.listUsers()).map(adminUserView));
  });

  app.post('/api/admin/users', requireSuperadmin, async (req, res) => {
    const email = str(req.body?.email, 'Email', { max: 200, required: true }).toLowerCase();
    const name = str(req.body?.name, 'Name', { max: 100, required: true });
    const password = requirePassword(req.body?.password);
    const role = req.body?.role === 'superadmin' ? 'superadmin' : 'user';
    if (await store.getUserByEmail(email)) throw new HttpError(409, 'Email already in use');
    const user = await store.createUser({ email, name, passwordHash: await hashPassword(password), role });
    res.status(201).json(adminUserView({ ...user, roomCount: 0 }));
  });

  app.patch('/api/admin/users/:id', requireSuperadmin, async (req, res) => {
    const target = await store.getUserById(req.params.id);
    if (!target) throw new HttpError(404, 'User not found');
    const patch = {};
    const body = req.body ?? {};

    if (body.name !== undefined) patch.name = str(body.name, 'Name', { max: 100, required: true });
    if (body.role !== undefined) {
      if (!['user', 'superadmin'].includes(body.role)) throw new HttpError(400, 'role must be "user" or "superadmin"');
      if (target.id === req.user.id && body.role !== req.user.role) throw new HttpError(400, 'You cannot change your own role');
      patch.role = body.role;
    }
    if (body.disabled !== undefined) {
      const disabled = Boolean(body.disabled);
      if (target.id === req.user.id && disabled) throw new HttpError(400, 'You cannot disable yourself');
      patch.disabled = disabled;
    }
    if (body.password !== undefined) patch.passwordHash = await hashPassword(requirePassword(body.password));

    await store.updateUser(target.id, patch);
    if (patch.disabled === true) await store.deleteUserSessions(target.id);
    res.json(adminUserView(await store.getUserById(target.id)));
  });

  // ----- images & static -----

  app.get('/uploads/:file', async (req, res) => {
    const id = req.params.file.replace(/\.\w+$/, '');
    const image = await store.getImage(id);
    if (!image) throw new HttpError(404, 'Image not found');
    res.set('Cache-Control', 'public, max-age=31536000, immutable').type(image.mime).send(image.data);
  });

  app.get('/admin/room', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'room.html')));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
  app.get('/play', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'play.html')));
  app.get('/room', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'room.html')));
  app.get('/watch', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'room.html')));
  app.get('/join', (req, res) => {
    const qs = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
    res.redirect(302, `/${qs}`);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const expected = err instanceof HttpError || status < 500;
    if (!expected) console.error(err);
    const extra = expected && err.extra ? err.extra : undefined;
    res.status(status).json({ error: expected ? err.message : 'Something went wrong', ...extra });
  });

  /** Wire up Socket.IO on the http.Server that serves this app: the room join/leave, cursor relay, and game protocol. */
  function attach(httpServer) {
    ({ io } = attachRealtime(httpServer, { store: () => store, roomService: () => roomService }));
    if (roomService) roomService.setIo(io);
    else pendingIo = io;
    return io;
  }

  /**
   * Shut down anything `attach`/`connect` started. `io.close()` also closes the http.Server it
   * was bound to, so the test harness's own `server.close()` afterwards would hit
   * ERR_SERVER_NOT_RUNNING — callers should tolerate that. Safe to call even if `attach` was
   * never called, or if the database never finished connecting.
   */
  function close() {
    return new Promise((resolve) => {
      roomService?.shutdown();
      if (!io) return resolve();
      io.close(() => resolve());
    });
  }

  return { app, ready, attach, close };
}

module.exports = { createApp };
