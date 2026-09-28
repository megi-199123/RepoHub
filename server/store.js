'use strict';

const crypto = require('crypto');
const { PLAYER_COLORS, PLAYER_AVATARS } = require('./rooms/constants');
const { roomCode } = require('./rooms/codes');
const { hashPassword } = require('./auth');

const newId = () => crypto.randomUUID();

/** Defaults for the jsonb subset of room settings. boxCount/style/countdownSeconds are plain
 *  room columns (unchanged from the pre-tenant schema), not part of this object. */
const DEFAULT_ROOM_SETTINGS = {
  title: 'Mystery Box',
  subtitle: 'Pick a box. Any box. Fortune favours the bold.',
  assignment: 'unique',
  showPrizes: true,
  maxPlaysPerVisitor: 0,
  // Only meaningful for managed rooms; RoomService.createRoom always forces this to false for a
  // `default` room (chat has no live board to attach to there), so this fallback only matters for
  // a managed room whose settings predate chatEnabled existing at all.
  chatEnabled: true,
};

const DEFAULT_BOX_COUNT = 4;
const DEFAULT_STYLE = 'gift';

const DEFAULT_PRIZES = [
  { name: 'Grand Prize', description: 'A brand-new smartphone', emoji: '📱', color: '#f59e0b', weight: 1, stock: 1, winning: true },
  { name: 'Gift Voucher', description: '₱500 shopping voucher', emoji: '🎟️', color: '#ec4899', weight: 3, stock: 20, winning: true },
  { name: 'Free Coffee', description: 'One cup on the house', emoji: '☕', color: '#8b5cf6', weight: 6, stock: null, winning: true },
  { name: 'Better Luck', description: 'Thanks for playing — try again!', emoji: '🍀', color: '#10b981', weight: 10, stock: null, winning: false },
];

// All SCHEMA statements must stay free of internal `;` (migrate() splits on it) and additive
// columns must stay nullable — the live Railway database already has rows in every one of these
// tables, and this runs on every boot.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    data jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user',
    disabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    expires_at timestamptz NOT NULL
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
  CREATE TABLE IF NOT EXISTS room_messages (
    id text PRIMARY KEY,
    room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    player_id text,
    author_role text NOT NULL,
    name text NOT NULL,
    color text,
    avatar text,
    text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted boolean NOT NULL DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS room_messages_room_idx ON room_messages (room_id, created_at);
  ALTER TABLE draws ADD COLUMN IF NOT EXISTS room_id text;
  ALTER TABLE draws ADD COLUMN IF NOT EXISTS player_name text;
  ALTER TABLE rooms ADD COLUMN IF NOT EXISTS owner_id text;
  ALTER TABLE rooms ADD COLUMN IF NOT EXISTS type text;
  ALTER TABLE rooms ADD COLUMN IF NOT EXISTS settings jsonb;
  ALTER TABLE prizes ADD COLUMN IF NOT EXISTS room_id text;
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS room_id text;
  ALTER TABLE images ADD COLUMN IF NOT EXISTS owner_id text;
  ALTER TABLE prizes ADD COLUMN IF NOT EXISTS image_border boolean NOT NULL DEFAULT true;
  CREATE INDEX IF NOT EXISTS prizes_room_idx ON prizes (room_id);
  CREATE INDEX IF NOT EXISTS draws_room_idx ON draws (room_id);
  CREATE INDEX IF NOT EXISTS rooms_owner_idx ON rooms (owner_id);
`;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Every scoped Store method takes its tenant/room key as an explicit argument; this guard makes
 *  a call site that forgets it fail loudly (TypeError) instead of silently running an unscoped
 *  query that would return every tenant's rows. */
function need(value, name) {
  if (value === undefined || value === null || value === '') throw new TypeError(`${name} is required`);
  return value;
}

function toUser(r) {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    disabled: r.disabled,
    createdAt: r.created_at,
    // Never spread this straight into an HTTP response — callers must pick fields explicitly.
    passwordHash: r.password_hash,
  };
}

function toPrize(r) {
  return {
    id: r.id,
    roomId: r.room_id,
    name: r.name,
    description: r.description,
    emoji: r.emoji,
    image: r.image,
    imageBorder: r.image_border,
    color: r.color,
    weight: r.weight,
    stock: r.stock,
    winning: r.winning,
    active: r.active,
    createdAt: r.created_at,
  };
}

function toMessage(r) {
  return {
    id: r.id,
    roomId: r.room_id,
    playerId: r.player_id,
    authorRole: r.author_role,
    name: r.name,
    color: r.color,
    avatar: r.avatar,
    text: r.text,
    createdAt: r.created_at,
    deleted: r.deleted,
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
    // Only present when the row came from listDraws()'s join (admin list/export); undefined
    // elsewhere (e.g. the plain RETURNING * of insertDraw/setRedeemed).
    roomCode: r.room_code,
    roomTitle: r.room_title,
    roomType: r.room_type,
  };
}

function toRoom(r) {
  return {
    id: r.id,
    code: r.code,
    ownerId: r.owner_id,
    type: r.type,
    game: r.game,
    status: r.status,
    style: r.style,
    boxCount: r.box_count,
    countdownSeconds: r.countdown_seconds,
    boxes: r.boxes,
    joinLocked: r.join_locked,
    countdownEndsAt: r.countdown_ends_at,
    // Defensive merge: a legacy row backfilled before its first settings write, or a row read
    // mid-migration, may still have a null settings column.
    settings: { ...DEFAULT_ROOM_SETTINGS, ...(r.settings || {}) },
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

const PRIZE_COLUMNS = ['name', 'description', 'emoji', 'image', 'image_border', 'color', 'weight', 'stock', 'winning', 'active'];
/** db column -> camelCase field, for the one PRIZE_COLUMNS entry whose JS key isn't just the column name itself. */
const PRIZE_FIELD_OVERRIDES = { image_border: 'imageBorder' };
const prizeParam = (col, p) => p[PRIZE_FIELD_OVERRIDES[col] || col];
const USER_FIELDS = { name: 'name', role: 'role', disabled: 'disabled', passwordHash: 'password_hash' };

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

/** All persistence goes through here. Every method is a small, self-contained query. Every method
 *  scoped to a room or an owner takes that id as an explicit argument (see `need` above) — there is
 *  no "give me everything" fallback for prizes/draws/rounds/settings. */
class Store {
  constructor(db) {
    this.db = db;
  }

  /**
   * Create tables and run one-time backfills. Safe to call from many instances at once (the
   * advisory lock serializes them) and safe to call twice (every step is conditioned so re-running
   * it against already-migrated data is a no-op). Runs on every boot against the real production
   * database, so every new column must be nullable and every backfill idempotent.
   */
  async migrate({ adminPassword, adminEmail } = {}) {
    await this.db.tx(async (q) => {
      await q('SELECT pg_advisory_xact_lock(724153)');
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await q(stmt);

      // 1. Bootstrap the superadmin on a fresh install (or an upgrade from before users existed).
      const [{ n: userCount }] = await q('SELECT COUNT(*)::int AS n FROM users');
      if (userCount === 0) {
        const email = (adminEmail || 'admin').toLowerCase();
        const passwordHash = await hashPassword(adminPassword || 'admin');
        await q(
          `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, 'Admin', $3, 'superadmin')`,
          [newId(), email, passwordHash],
        );
      }
      const [superadmin] = await q(`SELECT id FROM users WHERE role = 'superadmin' ORDER BY created_at LIMIT 1`);
      const superadminId = superadmin?.id;

      // 2. Legacy rooms predate owner_id/type. Close them out BEFORE stamping type = 'managed' —
      // closing on `type = 'managed'` instead would re-close every live room on every future boot.
      // After this runs once, `type IS NULL` matches zero rows, so it's a no-op from then on.
      await q(`UPDATE rooms SET status = 'closed', closed_at = COALESCE(closed_at, now()) WHERE type IS NULL AND status <> 'closed'`);
      await q(`UPDATE rooms SET type = 'managed' WHERE type IS NULL`);
      if (superadminId) await q(`UPDATE rooms SET owner_id = $1 WHERE owner_id IS NULL`, [superadminId]);

      // 3. Legacy solo data (the old global settings/prizes/draws, none of which had a room) moves
      // into one persistent `default` room owned by the superadmin. `_migratedRoomId` in the legacy
      // settings row marks this as done so it only ever runs once.
      if (superadminId) {
        const [legacySettings] = await q('SELECT data FROM settings WHERE id = 1');
        const migratedRoomId = legacySettings?.data?._migratedRoomId;

        if (legacySettings && !migratedRoomId) {
          const d = legacySettings.data || {};
          let code = null;
          for (let attempt = 0; attempt < 20 && !code; attempt++) {
            const candidate = roomCode();
            const [clash] = await q(`SELECT 1 FROM rooms WHERE code = $1 AND status <> 'closed'`, [candidate]);
            if (!clash) code = candidate;
          }
          if (!code) throw new Error('Could not allocate a room code for the legacy default room');

          const roomId = newId();
          const settings = {
            title: d.title ?? DEFAULT_ROOM_SETTINGS.title,
            subtitle: d.subtitle ?? DEFAULT_ROOM_SETTINGS.subtitle,
            assignment: d.assignment ?? DEFAULT_ROOM_SETTINGS.assignment,
            showPrizes: d.showPrizes ?? DEFAULT_ROOM_SETTINGS.showPrizes,
            maxPlaysPerVisitor: d.maxPlaysPerVisitor ?? DEFAULT_ROOM_SETTINGS.maxPlaysPerVisitor,
            chatEnabled: false, // this is always a `default` room — no live board, so no chat
          };
          await q(
            `INSERT INTO rooms (id, code, owner_id, type, status, style, box_count, settings)
             VALUES ($1, $2, $3, 'default', 'open', $4, $5, $6)`,
            [roomId, code, superadminId, d.boxStyle || DEFAULT_STYLE, d.boxCount || DEFAULT_BOX_COUNT, JSON.stringify(settings)],
          );
          await q('UPDATE prizes SET room_id = $1 WHERE room_id IS NULL', [roomId]);
          await q('UPDATE draws SET room_id = $1 WHERE room_id IS NULL', [roomId]);
          await q('DELETE FROM rounds WHERE room_id IS NULL');
          await q(
            `INSERT INTO settings (id, data) VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET data = settings.data || $1::jsonb`,
            [JSON.stringify({ _migratedRoomId: roomId })],
          );
        } else if (migratedRoomId) {
          // Defensive: fold any still-orphaned rows (e.g. from a partial run) into the room already
          // created for this install, rather than ever creating a second one.
          await q('UPDATE prizes SET room_id = $1 WHERE room_id IS NULL', [migratedRoomId]);
          await q('UPDATE draws SET room_id = $1 WHERE room_id IS NULL', [migratedRoomId]);
          await q('DELETE FROM rounds WHERE room_id IS NULL');
        }
      }
      // 4. Fresh install: no `settings` row exists yet, so the block above is skipped entirely —
      // superadmin only, no rooms, no sample prizes. (5. A new room's sample prizes are seeded by
      // `seedDefaultPrizes` at room-creation time, not here.)
    });
  }

  // ----- users -----

  async countUsers() {
    const [row] = await this.db.query('SELECT COUNT(*)::int AS n FROM users');
    return row.n;
  }

  async createUser({ id = newId(), email, name, passwordHash, role = 'user' }) {
    const [row] = await this.db.query(
      `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, String(email).toLowerCase(), name, passwordHash, role],
    );
    return toUser(row);
  }

  async getUserByEmail(email) {
    const [row] = await this.db.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
    return row ? toUser(row) : null;
  }

  async getUserById(id) {
    const [row] = await this.db.query(
      `SELECT u.*, (SELECT COUNT(*)::int FROM rooms r WHERE r.owner_id = u.id) AS room_count
       FROM users u WHERE u.id = $1`,
      [id],
    );
    return row ? { ...toUser(row), roomCount: row.room_count } : null;
  }

  async listUsers() {
    const rows = await this.db.query(
      `SELECT u.*, (SELECT COUNT(*)::int FROM rooms r WHERE r.owner_id = u.id) AS room_count
       FROM users u ORDER BY u.created_at`,
    );
    return rows.map((r) => ({ ...toUser(r), roomCount: r.room_count }));
  }

  async updateUser(id, patch = {}) {
    const entries = Object.entries(patch).filter(([k, v]) => k in USER_FIELDS && v !== undefined);
    if (entries.length === 0) return this.getUserById(id);
    const set = entries.map(([k], i) => `${USER_FIELDS[k]} = $${i + 2}`).join(', ');
    const values = entries.map(([, v]) => v);
    await this.db.query(`UPDATE users SET ${set} WHERE id = $1`, [id, ...values]);
    return this.getUserById(id);
  }

  // ----- user sessions -----

  async createUserSession(token, userId, ttlMs) {
    await this.db.query('DELETE FROM user_sessions WHERE expires_at < now()');
    await this.db.query(
      `INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3::float8 * interval '1 millisecond')`,
      [hashToken(token), userId, ttlMs],
    );
  }

  /** Only a session for a currently-not-disabled user is valid — disabling a user invalidates every session of theirs immediately. */
  async getSessionUser(token) {
    const rows = await this.db.query(
      `SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
      [hashToken(token)],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async deleteUserSession(token) {
    await this.db.query('DELETE FROM user_sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  async deleteUserSessions(userId) {
    await this.db.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
  }

  // ----- prizes (room-scoped) -----

  async listPrizes(roomId, q = this.db.query) {
    need(roomId, 'roomId');
    return (await q('SELECT * FROM prizes WHERE room_id = $1 ORDER BY position, created_at', [roomId])).map(toPrize);
  }

  async getPrize(roomId, id) {
    need(roomId, 'roomId');
    const [row] = await this.db.query('SELECT * FROM prizes WHERE id = $1 AND room_id = $2', [id, roomId]);
    return row ? toPrize(row) : null;
  }

  async createPrize(roomId, p) {
    need(roomId, 'roomId');
    const [row] = await this.db.query(
      `INSERT INTO prizes (id, room_id, ${PRIZE_COLUMNS.join(', ')}, position)
       VALUES ($1, $2, ${PRIZE_COLUMNS.map((_, i) => `$${i + 3}`).join(', ')},
               (SELECT COALESCE(MAX(position) + 1, 0) FROM prizes WHERE room_id = $2))
       RETURNING *`,
      [newId(), roomId, ...PRIZE_COLUMNS.map((c) => prizeParam(c, p))],
    );
    return toPrize(row);
  }

  async updatePrize(roomId, id, p) {
    need(roomId, 'roomId');
    const [row] = await this.db.query(
      `UPDATE prizes SET ${PRIZE_COLUMNS.map((c, i) => `${c} = $${i + 3}`).join(', ')} WHERE id = $1 AND room_id = $2 RETURNING *`,
      [id, roomId, ...PRIZE_COLUMNS.map((c) => prizeParam(c, p))],
    );
    return row ? toPrize(row) : null;
  }

  async deletePrize(roomId, id) {
    need(roomId, 'roomId');
    const rows = await this.db.query('DELETE FROM prizes WHERE id = $1 AND room_id = $2 RETURNING id', [id, roomId]);
    return rows.length > 0;
  }

  async reorderPrizes(roomId, ids) {
    need(roomId, 'roomId');
    await this.db.tx(async (q) => {
      for (const [i, id] of ids.entries()) await q('UPDATE prizes SET position = $3 WHERE id = $1 AND room_id = $2', [id, roomId, i]);
    });
  }

  async wonCounts(roomId) {
    need(roomId, 'roomId');
    const rows = await this.db.query('SELECT prize_id, COUNT(*)::int AS n FROM draws WHERE room_id = $1 GROUP BY prize_id', [roomId]);
    return Object.fromEntries(rows.map((r) => [r.prize_id, r.n]));
  }

  async seedDefaultPrizes(roomId) {
    need(roomId, 'roomId');
    await this.db.tx(async (q) => {
      for (const [i, p] of DEFAULT_PRIZES.entries()) {
        await q(
          `INSERT INTO prizes (id, room_id, name, description, emoji, color, weight, stock, winning, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [newId(), roomId, p.name, p.description, p.emoji, p.color, p.weight, p.stock, p.winning, i],
        );
      }
    });
  }

  /** Copies another (caller-owned) room's prizes as fresh rows into a brand-new room. */
  async copyPrizes(fromRoomId, toRoomId) {
    need(fromRoomId, 'fromRoomId');
    need(toRoomId, 'toRoomId');
    const rows = await this.db.query('SELECT * FROM prizes WHERE room_id = $1 ORDER BY position, created_at', [fromRoomId]);
    await this.db.tx(async (q) => {
      for (const [i, r] of rows.entries()) {
        await q(
          `INSERT INTO prizes (id, room_id, name, description, emoji, image, image_border, color, weight, stock, winning, active, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [newId(), toRoomId, r.name, r.description, r.emoji, r.image, r.image_border, r.color, r.weight, r.stock, r.winning, r.active, i],
        );
      }
    });
  }

  // ----- rounds (room-scoped; default rooms only) -----

  async createRound({ roomId, visitor, boxes, ttlMs }) {
    need(roomId, 'roomId');
    const id = newId();
    // Opportunistic cleanup keeps the table tiny without a cron job.
    await this.db.query('DELETE FROM rounds WHERE expires_at < now()');
    await this.db.query(
      `INSERT INTO rounds (id, room_id, visitor, boxes, expires_at) VALUES ($1, $2, $3, $4, now() + $5::float8 * interval '1 millisecond')`,
      [id, roomId, visitor, JSON.stringify(boxes), ttlMs],
    );
    return id;
  }

  /**
   * Open a box atomically: claim the round for this room+visitor (so it can only be opened once,
   * and never by another room's visitor), take one unit of stock, and record the draw — all in one
   * transaction. `choose(boxes, q)` runs inside the transaction and returns the result to record.
   */
  async openRound({ roundId, roomId, visitor }, choose) {
    need(roomId, 'roomId');
    return this.db.tx(async (q) => {
      const [round] = await q(
        'DELETE FROM rounds WHERE id = $1 AND room_id = $2 AND visitor = $3 AND expires_at > now() RETURNING boxes',
        [roundId, roomId, visitor],
      );
      if (!round) return null;
      return choose(round.boxes, q);
    });
  }

  /** Take one unit of stock if the prize is still available in this room. Returns the prize or null. */
  async takePrize(q, roomId, id) {
    need(roomId, 'roomId');
    const [row] = await q(
      `UPDATE prizes SET stock = stock - 1
       WHERE id = $1 AND room_id = $2 AND active AND weight > 0 AND (stock IS NULL OR stock > 0)
       RETURNING *`,
      [id, roomId],
    );
    return row ? toPrize(row) : null;
  }

  // ----- draws -----

  /** Plays for a visitor in one specific room (a default room's own budget; a managed room's draws
   *  live under a different room_id and so never count here). */
  async playsBy(visitor, roomId, q = this.db.query) {
    need(roomId, 'roomId');
    const [row] = await q('SELECT COUNT(*)::int AS n FROM draws WHERE visitor = $1 AND room_id = $2', [visitor, roomId]);
    return row.n;
  }

  async insertDraw(q, d) {
    need(d.roomId, 'roomId');
    const [row] = await q(
      `INSERT INTO draws (id, code, prize_id, prize_name, emoji, visitor, room_id, player_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [newId(), d.code, d.prizeId, d.prizeName, d.emoji, d.visitor, d.roomId, d.playerName ?? null],
    );
    return toDraw(row);
  }

  /** All draws for rooms owned by `ownerId` (including closed/swept rooms), optionally narrowed to one room. */
  async listDraws(ownerId, roomId) {
    need(ownerId, 'ownerId');
    const params = [ownerId];
    let where = 'r.owner_id = $1';
    if (roomId) {
      params.push(roomId);
      where += ` AND d.room_id = $${params.length}`;
    }
    return (await this.db.query(
      `SELECT d.*, r.code AS room_code, r.type AS room_type, r.settings->>'title' AS room_title
       FROM draws d JOIN rooms r ON r.id = d.room_id
       WHERE ${where}
       ORDER BY d.created_at DESC`,
      params,
    )).map(toDraw);
  }

  async setRedeemed(ownerId, id, redeemed) {
    need(ownerId, 'ownerId');
    const [row] = await this.db.query(
      `UPDATE draws d SET redeemed = $3, redeemed_at = CASE WHEN $3 THEN now() END
       FROM rooms r WHERE d.id = $1 AND d.room_id = r.id AND r.owner_id = $2
       RETURNING d.*`,
      [id, ownerId, redeemed],
    );
    return row ? toDraw(row) : null;
  }

  /** Clears draws for rooms owned by `ownerId` — every one of them, or just one room if `roomId` is given. */
  async clearDraws(ownerId, roomId) {
    need(ownerId, 'ownerId');
    const params = [ownerId];
    let where = 'room_id IN (SELECT id FROM rooms WHERE owner_id = $1)';
    if (roomId) {
      params.push(roomId);
      where += ` AND room_id = $${params.length}`;
    }
    await this.db.query(`DELETE FROM draws WHERE ${where}`, params);
  }

  // ----- images -----

  async saveImage(mime, buffer, ownerId) {
    const id = newId();
    await this.db.query('INSERT INTO images (id, mime, data, owner_id) VALUES ($1, $2, $3, $4)', [id, mime, buffer, ownerId ?? null]);
    return id;
  }

  /** Public: prize images must be viewable by any player, so this is intentionally not owner-scoped. */
  async getImage(id) {
    const [row] = await this.db.query('SELECT mime, data FROM images WHERE id = $1', [id]);
    return row ? { mime: row.mime, data: Buffer.from(row.data) } : null;
  }

  // ----- rooms -----

  /** Insert a new room. On a duplicate active code (23505) returns null so the caller retries with a new code. */
  async createRoom({ ownerId, code, type, status, style, boxCount, countdownSeconds, settings }) {
    try {
      const [row] = await this.db.query(
        `INSERT INTO rooms (id, code, owner_id, type, status, style, box_count, countdown_seconds, settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [newId(), code, ownerId, type, status, style, boxCount, countdownSeconds ?? null, JSON.stringify(settings || {})],
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

  /** Foreign-resource guard: a room only "exists" for admin purposes if this owner owns it — otherwise treat it as not found (404), never leak that some other tenant's room exists. */
  async getOwnedRoom(ownerId, id) {
    need(ownerId, 'ownerId');
    const [row] = await this.db.query('SELECT * FROM rooms WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    return row ? toRoom(row) : null;
  }

  /** Lock the room row for the rest of the transaction (join races, reveal races, …). */
  async lockRoom(q, id) {
    const [row] = await q('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [id]);
    return row ? toRoom(row) : null;
  }

  async listRooms(ownerId, includeClosed) {
    need(ownerId, 'ownerId');
    const rows = await this.db.query(
      `SELECT r.*,
              COUNT(*) FILTER (WHERE rp.role = 'player' AND NOT rp.kicked)::int AS player_count,
              COUNT(*) FILTER (WHERE rp.role = 'spectator' AND NOT rp.kicked)::int AS spectator_count,
              (SELECT COUNT(*)::int FROM prizes p WHERE p.room_id = r.id) AS prize_count,
              (SELECT COUNT(*)::int FROM draws d WHERE d.room_id = r.id) AS draw_count
       FROM rooms r
       LEFT JOIN room_players rp ON rp.room_id = r.id
       WHERE r.owner_id = $1 AND ($2::bool OR r.status <> 'closed')
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [ownerId, Boolean(includeClosed)],
    );
    return rows.map((r) => ({
      ...toRoom(r),
      playerCount: r.player_count,
      spectatorCount: r.spectator_count,
      prizeCount: r.prize_count,
      drawCount: r.draw_count,
    }));
  }

  async roomCounts(id) {
    const [row] = await this.db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM room_players WHERE room_id = $1 AND role = 'player' AND NOT kicked) AS player_count,
         (SELECT COUNT(*)::int FROM room_players WHERE room_id = $1 AND role = 'spectator' AND NOT kicked) AS spectator_count,
         (SELECT COUNT(*)::int FROM prizes WHERE room_id = $1) AS prize_count,
         (SELECT COUNT(*)::int FROM draws WHERE room_id = $1) AS draw_count`,
      [id],
    );
    return { playerCount: row.player_count, spectatorCount: row.spectator_count, prizeCount: row.prize_count, drawCount: row.draw_count };
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

  /** Merges `settingsPatch` into the settings jsonb and optionally updates the plain boxCount/style/countdownSeconds columns. */
  async updateRoomSettings(id, { settingsPatch, boxCount, style, countdownSeconds } = {}) {
    const sets = [`settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb`];
    const values = [id, JSON.stringify(settingsPatch || {})];
    if (boxCount !== undefined) { values.push(boxCount); sets.push(`box_count = $${values.length}`); }
    if (style !== undefined) { values.push(style); sets.push(`style = $${values.length}`); }
    if (countdownSeconds !== undefined) { values.push(countdownSeconds); sets.push(`countdown_seconds = $${values.length}`); }
    const [row] = await this.db.query(`UPDATE rooms SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values);
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

  /** Looked up by id alone (ids are globally unique) — used by chat to render a message's author. */
  async getPlayerById(id) {
    const [row] = await this.db.query('SELECT * FROM room_players WHERE id = $1', [id]);
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

  /** A visitor who already holds a spectator row joins with a name and a free seat: promote that
   *  same row to a player, replacing the watch-placeholder name with the one they typed. */
  async upgradeToPlayer(q, id, name) {
    const [row] = await q(`UPDATE room_players SET role = 'player', name = $2 WHERE id = $1 RETURNING *`, [id, name]);
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

  // ----- chat -----

  /** Inserts a message, then trims that room down to its newest 100 (oldest first to go). */
  async insertMessage({ roomId, playerId, authorRole, name, color, avatar, text }) {
    const id = newId();
    await this.db.query(
      `INSERT INTO room_messages (id, room_id, player_id, author_role, name, color, avatar, text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, roomId, playerId ?? null, authorRole, name, color ?? null, avatar ?? null, text],
    );
    await this.db.query(
      `DELETE FROM room_messages WHERE id IN (
         SELECT id FROM room_messages WHERE room_id = $1 ORDER BY created_at DESC OFFSET 100
       )`,
      [roomId],
    );
    const [row] = await this.db.query('SELECT * FROM room_messages WHERE id = $1', [id]);
    return toMessage(row);
  }

  /** The most recent non-deleted messages for a room, oldest first (for chat:history). */
  async listRecentMessages(roomId, limit = 50) {
    const rows = await this.db.query(
      `SELECT * FROM (
         SELECT * FROM room_messages WHERE room_id = $1 AND NOT deleted ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at ASC`,
      [roomId, limit],
    );
    return rows.map(toMessage);
  }

  /** Guarded on `NOT deleted` so re-deleting an already-deleted message 404s instead of a silent
   *  repeat success (and never re-broadcasts a stale chat:deleted for it). */
  async markMessageDeleted(roomId, id) {
    const [row] = await this.db.query(
      'UPDATE room_messages SET deleted = true WHERE id = $1 AND room_id = $2 AND NOT deleted RETURNING *',
      [id, roomId],
    );
    return row ? toMessage(row) : null;
  }

  // ----- room sweeping -----

  /** Stale rooms a background sweep should close: inactive lobbies/games, or long-finished ones.
   *  Default rooms are persistent (only their owner closes them) and are never swept. */
  async roomsToSweep() {
    return (await this.db.query(
      `SELECT * FROM rooms
       WHERE type <> 'default' AND (
         (status IN ('lobby', 'picking', 'locked', 'revealing') AND last_activity_at < now() - interval '2 hours')
         OR (status = 'finished' AND finished_at < now() - interval '30 minutes')
       )`,
    )).map(toRoom);
  }

  async activeCountdowns() {
    return (await this.db.query(
      `SELECT * FROM rooms WHERE status = 'picking' AND countdown_ends_at IS NOT NULL`,
    )).map(toRoom);
  }
}

module.exports = { Store, newId, DEFAULT_ROOM_SETTINGS, DEFAULT_BOX_COUNT, DEFAULT_STYLE, DEFAULT_PRIZES, SCHEMA };
