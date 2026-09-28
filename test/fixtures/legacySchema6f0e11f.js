'use strict';

// Frozen copy of server/store.js's SCHEMA + defaults as of commit 6f0e11f (the last commit before
// the tenant-rooms migration). Used only by test/migration.test.js to build a pre-migration
// database and prove `Store.migrate()` upgrades it correctly — this file must never be edited to
// match new code; it is the fixed "before" snapshot the upgrade test builds from.
//
// Notably: `prizes` and `rounds` have no `room_id` column at all yet (added by the new migration),
// and `rooms` has no `owner_id`/`type`/`settings` columns yet.

const LEGACY_DEFAULT_SETTINGS = {
  title: 'Mystery Box',
  subtitle: 'Pick a box. Any box. Fortune favours the bold.',
  boxCount: 4,
  assignment: 'unique',
  showPrizes: true,
  maxPlaysPerVisitor: 0,
  boxStyle: 'gift',
};

const LEGACY_DEFAULT_PRIZES = [
  { name: 'Grand Prize', description: 'A brand-new smartphone', emoji: '📱', color: '#f59e0b', weight: 1, stock: 1, winning: true },
  { name: 'Gift Voucher', description: '₱500 shopping voucher', emoji: '🎟️', color: '#ec4899', weight: 3, stock: 20, winning: true },
  { name: 'Free Coffee', description: 'One cup on the house', emoji: '☕', color: '#8b5cf6', weight: 6, stock: null, winning: true },
  { name: 'Better Luck', description: 'Thanks for playing — try again!', emoji: '🍀', color: '#10b981', weight: 10, stock: null, winning: false },
];

const LEGACY_SCHEMA = `
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

module.exports = { LEGACY_SCHEMA, LEGACY_DEFAULT_SETTINGS, LEGACY_DEFAULT_PRIZES };
