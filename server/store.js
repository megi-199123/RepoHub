'use strict';

const crypto = require('crypto');

const newId = () => crypto.randomUUID();

const DEFAULT_SETTINGS = {
  title: 'Mystery Box',
  subtitle: 'Pick a box. Any box. Fortune favours the bold.',
  boxCount: 4,
  assignment: 'unique',
  showPrizes: true,
  maxPlaysPerVisitor: 0,
};

const DEFAULT_PRIZES = [
  { name: 'Grand Prize', description: 'A brand-new smartphone', emoji: '📱', color: '#f59e0b', weight: 1, stock: 1, winning: true },
  { name: 'Gift Voucher', description: '₱500 shopping voucher', emoji: '🎟️', color: '#ec4899', weight: 3, stock: 20, winning: true },
  { name: 'Free Coffee', description: 'One cup on the house', emoji: '☕', color: '#8b5cf6', weight: 6, stock: null, winning: true },
  { name: 'Better Luck', description: 'Thanks for playing — try again!', emoji: '🍀', color: '#10b981', weight: 10, stock: null, winning: false },
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    data jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prizes (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    emoji text NOT NULL DEFAULT '🎁',
    image text,
    color text NOT NULL,
    weight integer NOT NULL,
    stock integer,
    winning boolean NOT NULL DEFAULT true,
    active boolean NOT NULL DEFAULT true,
    position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS draws (
    id text PRIMARY KEY,
    code text UNIQUE,
    prize_id text,
    prize_name text NOT NULL,
    emoji text NOT NULL,
    visitor text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    redeemed boolean NOT NULL DEFAULT false,
    redeemed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS draws_visitor_idx ON draws (visitor);
  CREATE INDEX IF NOT EXISTS draws_created_idx ON draws (created_at DESC);
  CREATE TABLE IF NOT EXISTS rounds (
    id text PRIMARY KEY,
    visitor text NOT NULL,
    boxes jsonb NOT NULL,
    expires_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash text PRIMARY KEY,
    expires_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS images (
    id text PRIMARY KEY,
    mime text NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function toPrize(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    emoji: r.emoji,
    image: r.image,
    color: r.color,
    weight: r.weight,
    stock: r.stock,
    winning: r.winning,
    active: r.active,
    createdAt: r.created_at,
  };
}

function toDraw(r) {
  return {
    id: r.id,
    code: r.code,
    prizeId: r.prize_id,
    prizeName: r.prize_name,
    emoji: r.emoji,
    createdAt: r.created_at,
    redeemed: r.redeemed,
    redeemedAt: r.redeemed_at,
  };
}

const PRIZE_COLUMNS = ['name', 'description', 'emoji', 'image', 'color', 'weight', 'stock', 'winning', 'active'];

/** All persistence goes through here. Every method is a small, self-contained query. */
class Store {
  constructor(db) {
    this.db = db;
  }

  /** Create tables and seed sample data on first run. Safe to call from many instances at once. */
  async migrate() {
    await this.db.tx(async (q) => {
      await q('SELECT pg_advisory_xact_lock(724153)');
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await q(stmt);
      const seeded = await q('SELECT 1 FROM settings');
      if (seeded.length) return;
      await q('INSERT INTO settings (id, data) VALUES (1, $1)', [JSON.stringify(DEFAULT_SETTINGS)]);
      for (const [i, p] of DEFAULT_PRIZES.entries()) {
        await q(
          `INSERT INTO prizes (id, name, description, emoji, color, weight, stock, winning, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [newId(), p.name, p.description, p.emoji, p.color, p.weight, p.stock, p.winning, i],
        );
      }
    });
  }

  // ----- settings -----

  async getSettings() {
    const [row] = await this.db.query('SELECT data FROM settings WHERE id = 1');
    return { ...DEFAULT_SETTINGS, ...row?.data };
  }

  async saveSettings(settings) {
    await this.db.query(
      'INSERT INTO settings (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
      [JSON.stringify(settings)],
    );
    return settings;
  }

  // ----- prizes -----

  async listPrizes(q = this.db.query) {
    return (await q('SELECT * FROM prizes ORDER BY position, created_at')).map(toPrize);
  }

  async getPrize(id) {
    const [row] = await this.db.query('SELECT * FROM prizes WHERE id = $1', [id]);
    return row ? toPrize(row) : null;
  }

  async createPrize(p) {
    const [row] = await this.db.query(
      `INSERT INTO prizes (id, ${PRIZE_COLUMNS.join(', ')}, position)
       VALUES ($1, ${PRIZE_COLUMNS.map((_, i) => `$${i + 2}`).join(', ')},
               (SELECT COALESCE(MAX(position) + 1, 0) FROM prizes))
       RETURNING *`,
      [newId(), ...PRIZE_COLUMNS.map((c) => p[c])],
    );
    return toPrize(row);
  }

  async updatePrize(id, p) {
    const [row] = await this.db.query(
      `UPDATE prizes SET ${PRIZE_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...PRIZE_COLUMNS.map((c) => p[c])],
    );
    return row ? toPrize(row) : null;
  }

  async deletePrize(id) {
    const rows = await this.db.query('DELETE FROM prizes WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  async reorderPrizes(ids) {
    await this.db.tx(async (q) => {
      for (const [i, id] of ids.entries()) await q('UPDATE prizes SET position = $2 WHERE id = $1', [id, i]);
    });
  }

  async wonCounts() {
    const rows = await this.db.query('SELECT prize_id, COUNT(*)::int AS n FROM draws GROUP BY prize_id');
    return Object.fromEntries(rows.map((r) => [r.prize_id, r.n]));
  }

  // ----- rounds -----

  async createRound({ visitor, boxes, ttlMs }) {
    const id = newId();
    // Opportunistic cleanup keeps the table tiny without a cron job.
    await this.db.query('DELETE FROM rounds WHERE expires_at < now()');
    await this.db.query(
      `INSERT INTO rounds (id, visitor, boxes, expires_at) VALUES ($1, $2, $3, now() + $4::float8 * interval '1 millisecond')`,
      [id, visitor, JSON.stringify(boxes), ttlMs],
    );
    return id;
  }

  /**
   * Open a box atomically: claim the round (so it can only be opened once),
   * take one unit of stock, and record the draw — all in one transaction.
   * `choose(boxes, q)` runs inside the transaction and returns the draw to record.
   */
  async openRound({ roundId, visitor }, choose) {
    return this.db.tx(async (q) => {
      const [round] = await q(
        'DELETE FROM rounds WHERE id = $1 AND visitor = $2 AND expires_at > now() RETURNING boxes',
        [roundId, visitor],
      );
      if (!round) return null;
      return choose(round.boxes, q);
    });
  }

  /** Take one unit of stock if the prize is still available. Returns the prize or null. */
  async takePrize(q, id) {
    const [row] = await q(
      `UPDATE prizes SET stock = stock - 1
       WHERE id = $1 AND active AND weight > 0 AND (stock IS NULL OR stock > 0)
       RETURNING *`,
      [id],
    );
    return row ? toPrize(row) : null;
  }

  // ----- draws -----

  async playsBy(visitor, q = this.db.query) {
    const [row] = await q('SELECT COUNT(*)::int AS n FROM draws WHERE visitor = $1', [visitor]);
    return row.n;
  }

  async insertDraw(q, d) {
    const [row] = await q(
      `INSERT INTO draws (id, code, prize_id, prize_name, emoji, visitor)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [newId(), d.code, d.prizeId, d.prizeName, d.emoji, d.visitor],
    );
    return toDraw(row);
  }

  async listDraws() {
    return (await this.db.query('SELECT * FROM draws ORDER BY created_at DESC')).map(toDraw);
  }

  async setRedeemed(id, redeemed) {
    const [row] = await this.db.query(
      `UPDATE draws SET redeemed = $2, redeemed_at = CASE WHEN $2 THEN now() END WHERE id = $1 RETURNING *`,
      [id, redeemed],
    );
    return row ? toDraw(row) : null;
  }

  async clearDraws() {
    await this.db.query('DELETE FROM draws');
  }

  // ----- admin sessions -----

  async createSession(token, ttlMs) {
    await this.db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
    await this.db.query(
      `INSERT INTO admin_sessions (token_hash, expires_at) VALUES ($1, now() + $2::float8 * interval '1 millisecond')`,
      [hashToken(token), ttlMs],
    );
  }

  async isSessionValid(token) {
    const rows = await this.db.query(
      'SELECT 1 FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()',
      [hashToken(token)],
    );
    return rows.length > 0;
  }

  async deleteSession(token) {
    await this.db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  // ----- images -----

  async saveImage(mime, buffer) {
    const id = newId();
    await this.db.query('INSERT INTO images (id, mime, data) VALUES ($1, $2, $3)', [id, mime, buffer]);
    return id;
  }

  async getImage(id) {
    const [row] = await this.db.query('SELECT mime, data FROM images WHERE id = $1', [id]);
    return row ? { mime: row.mime, data: Buffer.from(row.data) } : null;
  }
}

module.exports = { Store, newId };
