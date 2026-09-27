'use strict';

const crypto = require('crypto');
const { PLAYER_COLORS, PLAYER_AVATARS } = require('./rooms/constants');

const newId = () => crypto.randomUUID();

const DEFAULT_SETTINGS = {
  title: 'Mystery Box',
  subtitle: 'Pick a box. Any box. Fortune favours the bold.',
  boxCount: 4,
  assignment: 'unique',
  showPrizes: true,
  maxPlaysPerVisitor: 0,
  boxStyle: 'gift',
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
  CREATE TABLE IF NOT EXISTS rooms (
    id text PRIMARY KEY, code text NOT NULL, game text NOT NULL DEFAULT 'mysteryBox',
    status text NOT NULL DEFAULT 'lobby', style text NOT NULL DEFAULT 'gift',
    box_count integer NOT NULL, countdown_seconds integer, boxes jsonb,
    join_locked boolean NOT NULL DEFAULT false, countdown_ends_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), last_activity_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz, closed_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS rooms_active_code_idx ON rooms (code) WHERE status <> 'closed';
  CREATE TABLE IF NOT EXISTS room_players (
    id text PRIMARY KEY, room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    visitor text NOT NULL, name text NOT NULL, color text NOT NULL, avatar text NOT NULL,
    role text NOT NULL, join_order integer NOT NULL, locked_box integer,
    kicked boolean NOT NULL DEFAULT false, joined_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (room_id, visitor)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS room_players_lock_idx ON room_players (room_id, locked_box) WHERE locked_box IS NOT NULL;
  CREATE TABLE IF NOT EXISTS room_boxes (
    room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, box integer NOT NULL,
    prize_id text, player_id text, draw_id text, revealed_at timestamptz,
    PRIMARY KEY (room_id, box)
  );
  ALTER TABLE draws ADD COLUMN IF NOT EXISTS room_id text;
  ALTER TABLE draws ADD COLUMN IF NOT EXISTS player_name text;
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
    roomId: r.room_id,
    playerName: r.player_name,
    // Only present when the row came from listDraws()'s join below; undefined elsewhere (e.g. the
    // plain RETURNING * of insertDraw/setRedeemed), which is fine since only the admin list/export
    // needs it.
    roomCode: r.room_code,
  };
}

function toRoom(r) {
  return {
    id: r.id,
    code: r.code,
    game: r.game,
    status: r.status,
    style: r.style,
    boxCount: r.box_count,
    countdownSeconds: r.countdown_seconds,
    boxes: r.boxes,
    joinLocked: r.join_locked,
    countdownEndsAt: r.countdown_ends_at,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
    finishedAt: r.finished_at,
    closedAt: r.closed_at,
  };
}

function toPlayer(r) {
  return {
    id: r.id,
    roomId: r.room_id,
    visitor: r.visitor,
    name: r.name,
    color: r.color,
    avatar: r.avatar,
    role: r.role,
    joinOrder: r.join_order,
    lockedBox: r.locked_box,
    kicked: r.kicked,
    joinedAt: r.joined_at,
  };
}

function toBox(r) {
  return {
    roomId: r.room_id,
    box: r.box,
    prizeId: r.prize_id,
    playerId: r.player_id,
    drawId: r.draw_id,
    revealedAt: r.revealed_at,
  };
}

const PRIZE_COLUMNS = ['name', 'description', 'emoji', 'image', 'color', 'weight', 'stock', 'winning', 'active'];

/** camelCase field -> db column, for the whitelisted subset `setRoomFields` may write. */
const ROOM_FIELDS = {
  status: 'status',
  style: 'style',
  boxCount: 'box_count',
  countdownSeconds: 'countdown_seconds',
  boxes: 'boxes',
  joinLocked: 'join_locked',
  countdownEndsAt: 'countdown_ends_at',
  finishedAt: 'finished_at',
  closedAt: 'closed_at',
  lastActivityAt: 'last_activity_at',
};

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

  /** Solo plays only: a room draw (room_id set) must never count against a visitor's solo play budget. */
  async playsBy(visitor, q = this.db.query) {
    const [row] = await q('SELECT COUNT(*)::int AS n FROM draws WHERE visitor = $1 AND room_id IS NULL', [visitor]);
    return row.n;
  }

  async insertDraw(q, d) {
    const [row] = await q(
      `INSERT INTO draws (id, code, prize_id, prize_name, emoji, visitor, room_id, player_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [newId(), d.code, d.prizeId, d.prizeName, d.emoji, d.visitor, d.roomId ?? null, d.playerName ?? null],
    );
    return toDraw(row);
  }

  /** Left-joined to the room's code (never its internal id) so admin views/exports can show which
   *  room a draw belongs to without a second round-trip; solo draws (room_id NULL) get room_code NULL. */
  async listDraws() {
    return (await this.db.query(
      `SELECT d.*, r.code AS room_code
       FROM draws d LEFT JOIN rooms r ON r.id = d.room_id
       ORDER BY d.created_at DESC`,
    )).map(toDraw);
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

  // ----- rooms -----

  /** Insert a new room. On a duplicate active code (23505) returns null so the caller retries with a new code. */
  async createRoom({ code, style, boxCount, countdownSeconds }) {
    try {
      const [row] = await this.db.query(
        `INSERT INTO rooms (id, code, style, box_count, countdown_seconds)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [newId(), code, style, boxCount, countdownSeconds ?? null],
      );
      return toRoom(row);
    } catch (err) {
      if (err.code === '23505') return null;
      throw err;
    }
  }

  async getRoomByCode(code) {
    const [row] = await this.db.query(`SELECT * FROM rooms WHERE code = $1 AND status <> 'closed'`, [code]);
    return row ? toRoom(row) : null;
  }

  /**
   * Look up a room by code including closed ones (most recent by created_at), so a caller can
   * tell "never existed" (404) apart from "this code's room has ended" (409). Codes are reused
   * across rooms over time, but the active room (if any) is always the newest for its code.
   */
  async getRoomByCodeAny(code) {
    const [row] = await this.db.query('SELECT * FROM rooms WHERE code = $1 ORDER BY created_at DESC LIMIT 1', [code]);
    return row ? toRoom(row) : null;
  }

  async getRoom(id, q = this.db.query) {
    const [row] = await q('SELECT * FROM rooms WHERE id = $1', [id]);
    return row ? toRoom(row) : null;
  }

  /** Lock the room row for the rest of the transaction (join races, reveal races, …). */
  async lockRoom(q, id) {
    const [row] = await q('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [id]);
    return row ? toRoom(row) : null;
  }

  async listActiveRooms() {
    const rows = await this.db.query(
      `SELECT r.*,
              COUNT(*) FILTER (WHERE rp.role = 'player' AND NOT rp.kicked)::int AS player_count,
              COUNT(*) FILTER (WHERE rp.role = 'spectator' AND NOT rp.kicked)::int AS spectator_count
       FROM rooms r
       LEFT JOIN room_players rp ON rp.room_id = r.id
       WHERE r.status <> 'closed'
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
    );
    return rows.map((r) => ({ ...toRoom(r), playerCount: r.player_count, spectatorCount: r.spectator_count }));
  }

  async touchRoom(id) {
    await this.db.query('UPDATE rooms SET last_activity_at = now() WHERE id = $1', [id]);
  }

  /** Update only whitelisted room columns (see ROOM_FIELDS). Unknown keys are ignored. */
  async setRoomFields(q, id, fields) {
    const entries = Object.entries(fields).filter(([k]) => k in ROOM_FIELDS);
    if (entries.length === 0) {
      const [row] = await q('SELECT * FROM rooms WHERE id = $1', [id]);
      return row ? toRoom(row) : null;
    }
    const set = entries.map(([k], i) => `${ROOM_FIELDS[k]} = $${i + 2}`).join(', ');
    const values = entries.map(([k, v]) => (k === 'boxes' && v !== null ? JSON.stringify(v) : v));
    const [row] = await q(`UPDATE rooms SET ${set} WHERE id = $1 RETURNING *`, [id, ...values]);
    return row ? toRoom(row) : null;
  }

  /** Deal boxes and move a room out of the lobby. No-op (returns null) unless it is still in the lobby. */
  async beginPicking(id, boxes) {
    const [row] = await this.db.query(
      `UPDATE rooms SET status = 'picking', boxes = $2 WHERE id = $1 AND status = 'lobby' RETURNING *`,
      [id, JSON.stringify(boxes)],
    );
    return row ? toRoom(row) : null;
  }

  /** Arm a countdown. No-op (returns null) unless the room is still picking. */
  async armCountdown(id, endsAt) {
    const [row] = await this.db.query(
      `UPDATE rooms SET countdown_ends_at = $2 WHERE id = $1 AND status = 'picking' RETURNING *`,
      [id, endsAt],
    );
    return row ? toRoom(row) : null;
  }

  /** Countdown expiry: picking -> locked. No-op (returns null) if the room moved on already (stale timer). */
  async lockAfterCountdown(id) {
    const [row] = await this.db.query(
      `UPDATE rooms SET status = 'locked', countdown_ends_at = NULL WHERE id = $1 AND status = 'picking' RETURNING *`,
      [id],
    );
    return row ? toRoom(row) : null;
  }

  /**
   * First reveal only: picking|locked -> revealing, clearing any countdown. No-op (returns null)
   * if a reveal has already been prepared for this room (so callers can tell "I run the one-time
   * setup" apart from "setup already happened, just continue revealing").
   */
  async beginReveal(q, id) {
    const [row] = await q(
      `UPDATE rooms SET status = 'revealing', countdown_ends_at = NULL
       WHERE id = $1 AND status IN ('picking', 'locked') RETURNING *`,
      [id],
    );
    return row ? toRoom(row) : null;
  }

  /**
   * Finish a reveal: revealing -> finished. Conditioned on the current status (not just the id),
   * so a room that was concurrently closed mid-reveal can never be resurrected back to 'finished'
   * by a stale reveal step that was already in flight.
   */
  async finishReveal(q, id) {
    const [row] = await q(
      `UPDATE rooms SET status = 'finished', finished_at = now() WHERE id = $1 AND status = 'revealing' RETURNING *`,
      [id],
    );
    return row ? toRoom(row) : null;
  }

  // ----- room players -----

  async listPlayers(roomId, q = this.db.query) {
    return (await q('SELECT * FROM room_players WHERE room_id = $1 ORDER BY join_order', [roomId])).map(toPlayer);
  }

  async getPlayerByVisitor(roomId, visitor) {
    const [row] = await this.db.query('SELECT * FROM room_players WHERE room_id = $1 AND visitor = $2', [roomId, visitor]);
    return row ? toPlayer(row) : null;
  }

  /**
   * Add a player to a room. Locks the room row for the duration of the transaction so two
   * concurrent joins cannot compute the same join_order; color/avatar follow from it (join_order % 12).
   */
  async insertPlayer(q, { roomId, visitor, name, role }) {
    await q('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    const [{ next_order: nextOrder }] = await q(
      'SELECT COALESCE(MAX(join_order) + 1, 0)::int AS next_order FROM room_players WHERE room_id = $1',
      [roomId],
    );
    const [row] = await q(
      `INSERT INTO room_players (id, room_id, visitor, name, color, avatar, role, join_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [newId(), roomId, visitor, name, PLAYER_COLORS[nextOrder % 12], PLAYER_AVATARS[nextOrder % 12], role, nextOrder],
    );
    return toPlayer(row);
  }

  /**
   * Lock a player onto a box. The partial unique lock index on room_players (on
   * (room_id, locked_box) where locked_box IS NOT NULL) is the real guard against two players
   * locking the same box; a plain try/catch around a 23505 from that index would abort the
   * whole transaction on Postgres, so the UPDATE runs inside a SAVEPOINT: on conflict we roll
   * back to the savepoint (undoing only this statement) and return 'taken', leaving the
   * transaction itself usable for the caller to commit. Plain SQL SAVEPOINT/ROLLBACK TO/RELEASE
   * work the same way against both the pg driver and PGlite.
   */
  async setLock(q, roomId, playerId, box) {
    await q('SAVEPOINT set_lock');
    try {
      const [row] = await q(
        'UPDATE room_players SET locked_box = $3 WHERE id = $2 AND room_id = $1 AND NOT kicked RETURNING *',
        [roomId, playerId, box],
      );
      await q('RELEASE SAVEPOINT set_lock');
      return row ? toPlayer(row) : null;
    } catch (err) {
      if (err.code === '23505') {
        await q('ROLLBACK TO SAVEPOINT set_lock');
        return 'taken';
      }
      throw err;
    }
  }

  async clearLock(q, roomId, playerId) {
    await q('UPDATE room_players SET locked_box = NULL WHERE id = $2 AND room_id = $1', [roomId, playerId]);
  }

  async kickPlayer(q, roomId, playerId) {
    const [row] = await q(
      'UPDATE room_players SET kicked = true, locked_box = NULL WHERE id = $2 AND room_id = $1 RETURNING *',
      [roomId, playerId],
    );
    return row ? toPlayer(row) : null;
  }

  /** Used to promote the earliest spectator to a player seat when a player is kicked from the lobby. */
  async setPlayerRole(q, id, role) {
    const [row] = await q('UPDATE room_players SET role = $2 WHERE id = $1 RETURNING *', [id, role]);
    return row ? toPlayer(row) : null;
  }

  // ----- room boxes -----

  /**
   * Rows created only at the first reveal (see beginReveal): a locked box gets its final prize,
   * the locking player, and the draw it produced; an unlocked box gets only the dealt prize id.
   */
  async insertRoomBoxes(q, roomId, rows) {
    for (const r of rows) {
      await q(
        'INSERT INTO room_boxes (room_id, box, prize_id, player_id, draw_id) VALUES ($1, $2, $3, $4, $5)',
        [roomId, r.box, r.prizeId ?? null, r.playerId ?? null, r.drawId ?? null],
      );
    }
  }

  async listRoomBoxes(roomId, q = this.db.query) {
    return (await q('SELECT * FROM room_boxes WHERE room_id = $1 ORDER BY box', [roomId])).map(toBox);
  }

  /**
   * Guarded so a stale/duplicate reveal call cannot re-stamp (or double-count) an already-revealed
   * box, and so a room closed mid-reveal can't still have boxes opened by a reveal step still in flight.
   */
  async markBoxRevealed(q, roomId, box) {
    const [row] = await q(
      `UPDATE room_boxes SET revealed_at = now()
       WHERE room_id = $1 AND box = $2 AND revealed_at IS NULL
         AND EXISTS (SELECT 1 FROM rooms WHERE id = $1 AND status <> 'closed')
       RETURNING *`,
      [roomId, box],
    );
    return row ? toBox(row) : null;
  }

  /** The claim codes for a set of draw ids, keyed by draw id (used to build each viewer's `me.claimCode`). */
  async listDrawCodes(drawIds) {
    if (drawIds.length === 0) return {};
    const rows = await this.db.query('SELECT id, code FROM draws WHERE id = ANY($1)', [drawIds]);
    return Object.fromEntries(rows.map((r) => [r.id, r.code]));
  }

  // ----- room sweeping -----

  /** Stale rooms a background sweep should close: inactive lobbies/games, or long-finished ones. */
  async roomsToSweep() {
    return (await this.db.query(
      `SELECT * FROM rooms
       WHERE (status IN ('lobby', 'picking', 'locked', 'revealing') AND last_activity_at < now() - interval '2 hours')
          OR (status = 'finished' AND finished_at < now() - interval '30 minutes')`,
    )).map(toRoom);
  }

  async activeCountdowns() {
    return (await this.db.query(
      `SELECT * FROM rooms WHERE status = 'picking' AND countdown_ends_at IS NOT NULL`,
    )).map(toRoom);
  }
}

module.exports = { Store, newId };
