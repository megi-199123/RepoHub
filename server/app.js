'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Store, newId } = require('./store');
const { openDatabase } = require('./db');
const { fillBoxes, estimateOdds, isAvailable, weightedPick } = require('./draw');

const ROUND_TTL_MS = 30 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Human-friendly claim code without ambiguous characters (no 0/O, 1/I). */
function claimCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return `MB-${code.slice(0, 4)}-${code.slice(4)}`;
}

function publicPrize(p) {
  return { id: p.id, name: p.name, description: p.description, emoji: p.emoji, image: p.image, color: p.color, winning: p.winning };
}

// ---------- validation ----------

function str(value, field, { max = 200, required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  value = value.trim();
  if (required && !value) throw new HttpError(400, `${field} is required`);
  if (value.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return value;
}

function int(value, field, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

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
    color,
    weight: int(merged.weight ?? 1, 'Weight', 0, 100000),
    stock: merged.stock === null || merged.stock === '' || merged.stock === undefined
      ? null
      : int(merged.stock, 'Stock', 0, 1000000),
    active: merged.active !== false,
    winning: merged.winning !== false,
  };
}

function validateSettings(body, current) {
  const merged = { ...current, ...body };
  if (!['unique', 'weighted'].includes(merged.assignment)) {
    throw new HttpError(400, 'Assignment must be "unique" or "weighted"');
  }
  return {
    title: str(merged.title, 'Title', { max: 60, required: true }),
    subtitle: str(merged.subtitle, 'Subtitle', { max: 160 }),
    boxCount: int(merged.boxCount, 'Number of boxes', 2, 12),
    assignment: merged.assignment,
    showPrizes: Boolean(merged.showPrizes),
    maxPlaysPerVisitor: int(merged.maxPlaysPerVisitor ?? 0, 'Plays per visitor', 0, 1000),
  };
}

// ---------- app ----------

/**
 * Build the Express app. The database connects lazily on the first request,
 * which suits serverless hosts (Vercel) as well as a long-running server.
 *
 * Options: `db` (an already-open handle, used by tests) or `databaseUrl` / `dataDir`.
 */
function createApp({ db, databaseUrl, dataDir, adminPassword }) {
  let store;
  let connecting = null;
  // Connect once; if it fails (e.g. the database is briefly unreachable), the next request retries.
  const connect = () => {
    connecting ||= (async () => {
      const s = new Store(db || (await openDatabase({ databaseUrl, dataDir })));
      await s.migrate();
      store = s;
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

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const cookie = (req, name, value, opts) => {
    const secure = req.secure ? '; Secure' : '';
    return `${name}=${value}; ${opts}${secure}`;
  };

  app.use('/api', express.json({ limit: '4mb' }));

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

  const playsLeft = async (settings, visitor, q) => {
    const max = settings.maxPlaysPerVisitor;
    return max > 0 ? Math.max(0, max - (await store.playsBy(visitor, q))) : null;
  };

  // ----- public API -----

  app.get('/api/config', async (req, res) => {
    const [s, prizes] = await Promise.all([store.getSettings(), store.listPrizes()]);
    res.json({
      title: s.title,
      subtitle: s.subtitle,
      boxCount: s.boxCount,
      showPrizes: s.showPrizes,
      playsLeft: await playsLeft(s, req.visitor),
      prizes: s.showPrizes ? prizes.filter(isAvailable).map(publicPrize) : [],
    });
  });

  app.post('/api/rounds', async (req, res) => {
    const [s, prizes] = await Promise.all([store.getSettings(), store.listPrizes()]);
    if ((await playsLeft(s, req.visitor)) === 0) throw new HttpError(403, "You've used all your plays. Thanks for playing!");
    const boxes = fillBoxes(prizes, s.boxCount, s.assignment);
    if (!boxes) throw new HttpError(409, 'All prizes have been claimed. Check back soon!');
    const roundId = await store.createRound({ visitor: req.visitor, boxes, ttlMs: ROUND_TTL_MS });
    res.status(201).json({ roundId, boxCount: boxes.length });
  });

  app.post('/api/rounds/:id/pick', async (req, res) => {
    const box = int(req.body?.box, 'Box', 0, 11);
    const settings = await store.getSettings();

    const result = await store.openRound({ roundId: req.params.id, visitor: req.visitor }, async (boxes, q) => {
      if (box >= boxes.length) throw new HttpError(400, `Box must be between 0 and ${boxes.length - 1}`);
      if ((await playsLeft(settings, req.visitor, q)) === 0) {
        throw new HttpError(403, "You've used all your plays. Thanks for playing!");
      }

      // Take one unit of the box's prize. If it ran out since the round was dealt,
      // swap in something that is still available.
      let prize = await store.takePrize(q, boxes[box]);
      for (let attempt = 0; !prize && attempt < 5; attempt++) {
        const pool = (await store.listPrizes(q)).filter(isAvailable);
        if (pool.length === 0) throw new HttpError(409, 'All prizes have been claimed. Check back soon!');
        prize = await store.takePrize(q, weightedPick(pool).id);
      }
      if (!prize) throw new HttpError(409, 'Prizes are going fast — please try again!');
      boxes[box] = prize.id;

      const draw = await store.insertDraw(q, {
        code: prize.winning ? claimCode() : null,
        prizeId: prize.id,
        prizeName: prize.name,
        emoji: prize.emoji,
        visitor: req.visitor,
      });
      const all = new Map((await store.listPrizes(q)).map((p) => [p.id, p]));
      return {
        box,
        prize: publicPrize(prize),
        code: draw.code,
        boxes: boxes.map((id) => (all.has(id) ? publicPrize(all.get(id)) : null)),
        playsLeft: await playsLeft(settings, req.visitor, q),
      };
    });

    if (!result) throw new HttpError(404, 'This round has expired. Shuffle again!');
    res.json(result);
  });

  // ----- admin auth -----

  const isAdmin = async (req) => {
    const token = req.cookies.mb_admin;
    return Boolean(token && (await store.isSessionValid(token)));
  };

  app.post('/api/admin/login', async (req, res) => {
    if (!adminPassword) throw new HttpError(503, 'ADMIN_PASSWORD is not configured on the server');
    if (!safeEqual(req.body?.password ?? '', adminPassword)) throw new HttpError(401, 'Wrong password');
    const token = crypto.randomBytes(32).toString('hex');
    await store.createSession(token, SESSION_TTL_MS);
    res.append('Set-Cookie', cookie(req, 'mb_admin', token, `Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Strict; HttpOnly`));
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', async (req, res) => {
    if (req.cookies.mb_admin) await store.deleteSession(req.cookies.mb_admin);
    res.append('Set-Cookie', cookie(req, 'mb_admin', '', 'Path=/; Max-Age=0; SameSite=Strict; HttpOnly'));
    res.json({ ok: true });
  });

  app.get('/api/admin/me', async (req, res) => res.json({ authenticated: await isAdmin(req) }));

  app.use('/api/admin', async (req, res, next) => {
    if (!(await isAdmin(req))) throw new HttpError(401, 'Please sign in');
    next();
  });

  // ----- admin: settings -----

  app.get('/api/admin/settings', async (req, res) => res.json(await store.getSettings()));

  app.put('/api/admin/settings', async (req, res) => {
    const settings = validateSettings(req.body ?? {}, await store.getSettings());
    res.json(await store.saveSettings(settings));
  });

  // ----- admin: prizes -----

  app.get('/api/admin/prizes', async (req, res) => {
    const [prizes, won] = await Promise.all([store.listPrizes(), store.wonCounts()]);
    res.json(prizes.map((p) => ({ ...p, won: won[p.id] || 0, available: isAvailable(p) })));
  });

  app.post('/api/admin/prizes', async (req, res) => {
    res.status(201).json(await store.createPrize(validatePrize(req.body ?? {})));
  });

  app.put('/api/admin/prizes/:id', async (req, res) => {
    const existing = await store.getPrize(req.params.id);
    if (!existing) throw new HttpError(404, 'Prize not found');
    res.json(await store.updatePrize(req.params.id, validatePrize(req.body ?? {}, existing)));
  });

  app.delete('/api/admin/prizes/:id', async (req, res) => {
    if (!(await store.deletePrize(req.params.id))) throw new HttpError(404, 'Prize not found');
    res.status(204).end();
  });

  app.put('/api/admin/prizes-order', async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw new HttpError(400, 'ids must be an array');
    await store.reorderPrizes(ids);
    res.json({ ok: true });
  });

  app.get('/api/admin/odds', async (req, res) => {
    const [s, prizes] = await Promise.all([store.getSettings(), store.listPrizes()]);
    res.json(estimateOdds(prizes, s.boxCount, s.assignment));
  });

  // ----- admin: uploads (stored in the database, so no file storage is needed) -----

  app.post('/api/admin/uploads', async (req, res) => {
    const match = /^data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.dataUrl ?? '');
    const ext = match && IMAGE_TYPES[match[1]];
    if (!ext) throw new HttpError(400, 'Upload a PNG, JPG, WebP or GIF image');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Image must be 2 MB or smaller');
    const id = await store.saveImage(match[1], buffer);
    res.status(201).json({ url: `/uploads/${id}.${ext}` });
  });

  // ----- admin: draws (winners log) -----

  app.get('/api/admin/draws', async (req, res) => res.json(await store.listDraws()));

  app.patch('/api/admin/draws/:id', async (req, res) => {
    const draw = await store.setRedeemed(req.params.id, Boolean(req.body?.redeemed));
    if (!draw) throw new HttpError(404, 'Draw not found');
    res.json(draw);
  });

  app.delete('/api/admin/draws', async (req, res) => {
    await store.clearDraws();
    res.status(204).end();
  });

  app.get('/api/admin/draws.csv', async (req, res) => {
    const esc = (v) => `"${String(v instanceof Date ? v.toISOString() : v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Date', 'Claim code', 'Prize', 'Redeemed', 'Redeemed at']];
    for (const d of await store.listDraws()) rows.push([d.createdAt, d.code, d.prizeName, d.redeemed ? 'yes' : 'no', d.redeemedAt]);
    res.type('text/csv').attachment('mystery-box-draws.csv').send(rows.map((r) => r.map(esc).join(',')).join('\n'));
  });

  // ----- images & static -----

  app.get('/uploads/:file', async (req, res) => {
    const id = req.params.file.replace(/\.\w+$/, '');
    const image = await store.getImage(id);
    if (!image) throw new HttpError(404, 'Image not found');
    res.set('Cache-Control', 'public, max-age=31536000, immutable').type(image.mime).send(image.data);
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const expected = err instanceof HttpError || status < 500;
    if (!expected) console.error(err);
    res.status(status).json({ error: expected ? err.message : 'Something went wrong' });
  });

  return { app, ready };
}

module.exports = { createApp };
