'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Store, newId } = require('./store');
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

function createApp({ dataDir, adminPassword }) {
  const store = new Store(dataDir);
  const rounds = new Map(); // roundId -> { boxes, visitor, expires }
  const sessions = new Map(); // token -> expires

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // Every visitor gets an anonymous id cookie so plays-per-visitor can be enforced.
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    let visitor = req.cookies.mb_visitor;
    if (!visitor || !/^[\w-]{36}$/.test(visitor)) {
      visitor = newId();
      res.append('Set-Cookie', `mb_visitor=${visitor}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
    }
    req.visitor = visitor;
    next();
  });

  const playsBy = (visitor) => store.draws.filter((d) => d.visitor === visitor).length;
  const playsLeft = (visitor) => {
    const max = store.settings.maxPlaysPerVisitor;
    return max > 0 ? Math.max(0, max - playsBy(visitor)) : null;
  };

  const sweep = (map) => {
    const now = Date.now();
    for (const [k, v] of map) if ((v.expires ?? v) < now) map.delete(k);
  };

  // ----- public API -----

  app.get('/api/config', (req, res) => {
    const s = store.settings;
    res.json({
      title: s.title,
      subtitle: s.subtitle,
      boxCount: s.boxCount,
      showPrizes: s.showPrizes,
      playsLeft: playsLeft(req.visitor),
      prizes: s.showPrizes ? store.prizes.filter(isAvailable).map(publicPrize) : [],
    });
  });

  app.post('/api/rounds', (req, res) => {
    sweep(rounds);
    if (playsLeft(req.visitor) === 0) throw new HttpError(403, "You've used all your plays. Thanks for playing!");
    const boxes = fillBoxes(store.prizes, store.settings.boxCount, store.settings.assignment);
    if (!boxes) throw new HttpError(409, 'All prizes have been claimed. Check back soon!');
    const id = newId();
    rounds.set(id, { boxes, visitor: req.visitor, expires: Date.now() + ROUND_TTL_MS });
    res.status(201).json({ roundId: id, boxCount: boxes.length });
  });

  app.post('/api/rounds/:id/pick', (req, res) => {
    const round = rounds.get(req.params.id);
    if (!round || round.expires < Date.now() || round.visitor !== req.visitor) {
      throw new HttpError(404, 'This round has expired. Shuffle again!');
    }
    const box = int(req.body?.box, 'Box', 0, round.boxes.length - 1);
    if (playsLeft(req.visitor) === 0) throw new HttpError(403, "You've used all your plays. Thanks for playing!");
    rounds.delete(req.params.id);

    // Stock may have run out since the round was dealt; swap in something still available.
    let prize = store.findPrize(round.boxes[box]);
    if (!prize || !isAvailable(prize)) {
      const pool = store.prizes.filter(isAvailable);
      if (pool.length === 0) throw new HttpError(409, 'All prizes have been claimed. Check back soon!');
      prize = weightedPick(pool);
      round.boxes[box] = prize.id;
    }

    if (prize.stock !== null) prize.stock -= 1;
    const draw = {
      id: newId(),
      code: prize.winning ? claimCode() : null,
      prizeId: prize.id,
      prizeName: prize.name,
      emoji: prize.emoji,
      visitor: req.visitor,
      createdAt: new Date().toISOString(),
      redeemed: false,
    };
    store.draws.unshift(draw);
    store.save();

    const others = round.boxes.map((id) => {
      const p = store.findPrize(id);
      return p ? publicPrize(p) : null;
    });
    res.json({ box, prize: publicPrize(prize), code: draw.code, boxes: others, playsLeft: playsLeft(req.visitor) });
  });

  // ----- admin auth -----

  const isAdmin = (req) => {
    const token = req.cookies.mb_admin;
    const expires = token && sessions.get(token);
    return Boolean(expires && expires > Date.now());
  };

  const requireAdmin = (req, res, next) => {
    if (!isAdmin(req)) throw new HttpError(401, 'Please sign in');
    next();
  };

  app.post('/api/admin/login', (req, res) => {
    sweep(sessions);
    if (!safeEqual(req.body?.password ?? '', adminPassword)) throw new HttpError(401, 'Wrong password');
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    res.append('Set-Cookie', `mb_admin=${token}; Path=/api/admin; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Strict; HttpOnly`);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    sessions.delete(req.cookies.mb_admin);
    res.append('Set-Cookie', 'mb_admin=; Path=/api/admin; Max-Age=0; SameSite=Strict; HttpOnly');
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (req, res) => res.json({ authenticated: isAdmin(req) }));

  app.use('/api/admin', requireAdmin);

  // ----- admin: settings -----

  app.get('/api/admin/settings', (req, res) => res.json(store.settings));

  app.put('/api/admin/settings', (req, res) => {
    store.data.settings = validateSettings(req.body ?? {}, store.settings);
    store.save();
    res.json(store.settings);
  });

  // ----- admin: prizes -----

  app.get('/api/admin/prizes', (req, res) => {
    const won = {};
    for (const d of store.draws) won[d.prizeId] = (won[d.prizeId] || 0) + 1;
    res.json(store.prizes.map((p) => ({ ...p, won: won[p.id] || 0, available: isAvailable(p) })));
  });

  app.post('/api/admin/prizes', (req, res) => {
    const prize = { id: newId(), ...validatePrize(req.body ?? {}), createdAt: new Date().toISOString() };
    store.prizes.push(prize);
    store.save();
    res.status(201).json(prize);
  });

  app.put('/api/admin/prizes/:id', (req, res) => {
    const prize = store.findPrize(req.params.id);
    if (!prize) throw new HttpError(404, 'Prize not found');
    Object.assign(prize, validatePrize(req.body ?? {}, prize));
    store.save();
    res.json(prize);
  });

  app.delete('/api/admin/prizes/:id', (req, res) => {
    const i = store.prizes.findIndex((p) => p.id === req.params.id);
    if (i < 0) throw new HttpError(404, 'Prize not found');
    store.prizes.splice(i, 1);
    store.save();
    res.status(204).end();
  });

  app.put('/api/admin/prizes-order', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be an array');
    const rank = new Map(ids.map((id, i) => [id, i]));
    store.prizes.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    store.save();
    res.json({ ok: true });
  });

  app.get('/api/admin/odds', (req, res) => {
    res.json(estimateOdds(store.prizes, store.settings.boxCount, store.settings.assignment));
  });

  // ----- admin: uploads -----

  app.post('/api/admin/uploads', (req, res) => {
    const match = /^data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.dataUrl ?? '');
    const ext = match && IMAGE_TYPES[match[1]];
    if (!ext) throw new HttpError(400, 'Upload a PNG, JPG, WebP or GIF image');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Image must be 2 MB or smaller');
    const name = `${newId()}.${ext}`;
    fs.writeFileSync(path.join(store.uploadsDir, name), buffer);
    res.status(201).json({ url: `/uploads/${name}` });
  });

  // ----- admin: draws (winners log) -----

  app.get('/api/admin/draws', (req, res) => res.json(store.draws));

  app.patch('/api/admin/draws/:id', (req, res) => {
    const draw = store.draws.find((d) => d.id === req.params.id);
    if (!draw) throw new HttpError(404, 'Draw not found');
    draw.redeemed = Boolean(req.body?.redeemed);
    draw.redeemedAt = draw.redeemed ? new Date().toISOString() : null;
    store.save();
    res.json(draw);
  });

  app.delete('/api/admin/draws', (req, res) => {
    store.data.draws = [];
    store.save();
    res.status(204).end();
  });

  app.get('/api/admin/draws.csv', (req, res) => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Date', 'Claim code', 'Prize', 'Redeemed', 'Redeemed at']];
    for (const d of store.draws) rows.push([d.createdAt, d.code, d.prizeName, d.redeemed ? 'yes' : 'no', d.redeemedAt]);
    res.type('text/csv').attachment('mystery-box-draws.csv').send(rows.map((r) => r.map(esc).join(',')).join('\n'));
  });

  // ----- static -----

  app.use('/uploads', express.static(store.uploadsDir, { maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return { app, store };
}

module.exports = { createApp };
