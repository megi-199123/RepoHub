'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { openDatabase } = require('../server/db');
const { Store } = require('../server/store');
const { LEGACY_SCHEMA, LEGACY_DEFAULT_SETTINGS, LEGACY_DEFAULT_PRIZES } = require('./fixtures/legacySchema6f0e11f');

const newId = () => crypto.randomUUID();

let db;
after(async () => {
  if (db) await db.close();
});

/** Builds a fresh in-memory database on the pre-tenant-rooms (6f0e11f) schema and seeds it with
 *  representative legacy data: a customized global settings row, the 4 sample prizes (no room_id
 *  column exists yet), a couple of solo draws and a stale round (both room_id-less), one already
 *  active legacy multiplayer room, and one draw already tied to that room. */
async function seedLegacyDatabase() {
  const legacyDb = await openDatabase({ memory: true });
  for (const stmt of LEGACY_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await legacyDb.query(stmt);

  const settings = { ...LEGACY_DEFAULT_SETTINGS, title: 'Legacy Game', subtitle: 'Legacy subtitle', boxCount: 5, assignment: 'weighted', showPrizes: false, maxPlaysPerVisitor: 2, boxStyle: 'chest' };
  await legacyDb.query('INSERT INTO settings (id, data) VALUES (1, $1)', [JSON.stringify(settings)]);

  const prizeIds = [];
  for (const [i, p] of LEGACY_DEFAULT_PRIZES.entries()) {
    const id = newId();
    prizeIds.push(id);
    await legacyDb.query(
      `INSERT INTO prizes (id, name, description, emoji, color, weight, stock, winning, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, p.name, p.description, p.emoji, p.color, p.weight, p.stock, p.winning, i],
    );
  }

  // Two solo draws (room_id NULL — the column doesn't even exist on this legacy schema yet).
  const soloDrawIds = [];
  for (let i = 0; i < 2; i++) {
    const id = newId();
    soloDrawIds.push(id);
    await legacyDb.query(
      `INSERT INTO draws (id, code, prize_id, prize_name, emoji, visitor) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, `MB-LEGA-${i}CY1`, prizeIds[0], LEGACY_DEFAULT_PRIZES[0].name, LEGACY_DEFAULT_PRIZES[0].emoji, 'solo-visitor'],
    );
  }

  // A stale round, also room_id-less pre-migration.
  await legacyDb.query(
    `INSERT INTO rounds (id, visitor, boxes, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [newId(), 'solo-visitor', JSON.stringify(prizeIds)],
  );

  // One already-active legacy multiplayer room (pre-existing production data), plus a draw
  // already tied to it via the room_id column ALTER TABLE draws already had at 6f0e11f.
  const legacyRoomId = newId();
  await legacyDb.query(
    `INSERT INTO rooms (id, code, status, box_count) VALUES ($1, $2, 'lobby', 2)`,
    [legacyRoomId, '204060'],
  );
  const roomDrawId = newId();
  await legacyDb.query(
    `INSERT INTO draws (id, code, prize_id, prize_name, emoji, visitor, room_id, player_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [roomDrawId, 'MB-ROOM-DRAW', prizeIds[1], LEGACY_DEFAULT_PRIZES[1].name, LEGACY_DEFAULT_PRIZES[1].emoji, 'room-visitor', legacyRoomId, 'Player One'],
  );

  return { legacyDb, prizeIds, soloDrawIds, legacyRoomId, roomDrawId, settings };
}

test('upgrade: migrate() twice against 6f0e11f-shaped data seeds one superadmin, closes the legacy room, and moves orphaned data into one persistent default room — idempotently', async () => {
  const { legacyDb, prizeIds, soloDrawIds, legacyRoomId, roomDrawId, settings } = await seedLegacyDatabase();
  db = legacyDb;
  const store = new Store(legacyDb);

  await store.migrate({ adminPassword: 'hunter2' });

  // --- superadmin ---
  const usersAfterFirst = await store.listUsers();
  assert.equal(usersAfterFirst.length, 1);
  assert.equal(usersAfterFirst[0].email, 'admin');
  assert.equal(usersAfterFirst[0].role, 'superadmin');
  const superadminId = usersAfterFirst[0].id;

  // --- the legacy room: closed, typed, owned ---
  const legacyRoom = await store.getRoom(legacyRoomId);
  assert.equal(legacyRoom.status, 'closed');
  assert.equal(legacyRoom.type, 'managed');
  assert.equal(legacyRoom.ownerId, superadminId);

  // --- exactly one legacy default room, from the old settings row ---
  const [{ data: settingsData }] = await legacyDb.query('SELECT data FROM settings WHERE id = 1');
  const migratedRoomId = settingsData._migratedRoomId;
  assert.ok(migratedRoomId, 'expected settings.data._migratedRoomId to be set');
  const defaultRoom = await store.getRoom(migratedRoomId);
  assert.equal(defaultRoom.type, 'default');
  assert.equal(defaultRoom.status, 'open');
  assert.equal(defaultRoom.ownerId, superadminId);
  assert.equal(defaultRoom.settings.title, settings.title);
  assert.equal(defaultRoom.settings.subtitle, settings.subtitle);
  assert.equal(defaultRoom.settings.assignment, settings.assignment);
  assert.equal(defaultRoom.settings.showPrizes, settings.showPrizes);
  assert.equal(defaultRoom.settings.maxPlaysPerVisitor, settings.maxPlaysPerVisitor);
  assert.equal(defaultRoom.boxCount, settings.boxCount);
  assert.equal(defaultRoom.style, settings.boxStyle);
  // Addendum B2: a default room has no live board, so chat must come out disabled even though the
  // legacy settings row (which predates chat entirely) obviously has no opinion on it.
  assert.equal(defaultRoom.settings.chatEnabled, false);

  const rowsCheck = await legacyDb.query('SELECT COUNT(*)::int AS n FROM rooms');
  assert.equal(rowsCheck[0].n, 2, 'expected exactly the legacy room plus the one new default room');

  // --- prizes moved into the default room, and each one picked up Addendum B1's new column ---
  const movedPrizes = await store.listPrizes(migratedRoomId);
  assert.equal(movedPrizes.length, LEGACY_DEFAULT_PRIZES.length);
  assert.deepEqual(movedPrizes.map((p) => p.id).sort(), [...prizeIds].sort());
  assert.ok(movedPrizes.every((p) => p.imageBorder === true), 'image_border must backfill to true for every pre-existing prize row');

  // --- Addendum B2's room_messages table exists and is usable against a freshly-upgraded room ---
  const chatRoom = await store.getRoom(legacyRoomId);
  const message = await store.insertMessage({ roomId: chatRoom.id, playerId: null, authorRole: 'host', name: 'Admin', text: 'post-upgrade smoke test' });
  assert.equal(message.text, 'post-upgrade smoke test');
  const history = await store.listRecentMessages(chatRoom.id);
  assert.equal(history.length, 1);

  // --- solo draws moved into the default room; the room draw stayed with its own room ---
  const defaultRoomDraws = await store.listDraws(superadminId, migratedRoomId);
  assert.equal(defaultRoomDraws.length, soloDrawIds.length);
  assert.deepEqual(defaultRoomDraws.map((d) => d.id).sort(), [...soloDrawIds].sort());

  const legacyRoomDraws = await store.listDraws(superadminId, legacyRoomId);
  assert.equal(legacyRoomDraws.length, 1);
  assert.equal(legacyRoomDraws[0].id, roomDrawId);

  // --- the stale room_id-less round was deleted ---
  const roundsLeft = await legacyDb.query('SELECT COUNT(*)::int AS n FROM rounds');
  assert.equal(roundsLeft[0].n, 0);

  // --- run migrate() again: nothing duplicated ---
  await store.migrate({ adminPassword: 'hunter2' });

  const usersAfterSecond = await store.listUsers();
  assert.equal(usersAfterSecond.length, 1, 'a second migrate() must not create a second superadmin');
  assert.equal(usersAfterSecond[0].id, superadminId);

  const roomsAfterSecond = await legacyDb.query('SELECT COUNT(*)::int AS n FROM rooms');
  assert.equal(roomsAfterSecond[0].n, 2, 'a second migrate() must not create a second default room');

  const prizesAfterSecond = await store.listPrizes(migratedRoomId);
  assert.equal(prizesAfterSecond.length, LEGACY_DEFAULT_PRIZES.length);

  const drawsAfterSecond = await store.listDraws(superadminId);
  assert.equal(drawsAfterSecond.length, soloDrawIds.length + 1, 'draw count must be unchanged by the second run');

  const legacyRoomAfterSecond = await store.getRoom(legacyRoomId);
  assert.equal(legacyRoomAfterSecond.status, 'closed');
});

test('fresh install: migrate() seeds only the superadmin — no rooms, no sample prizes', async () => {
  const freshDb = await openDatabase({ memory: true });
  try {
    const store = new Store(freshDb);
    await store.migrate({ adminPassword: 'hunter2' });
    await store.migrate({ adminPassword: 'hunter2' });

    const users = await store.listUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'superadmin');

    const rooms = await freshDb.query('SELECT COUNT(*)::int AS n FROM rooms');
    assert.equal(rooms[0].n, 0);
    const settingsRows = await freshDb.query('SELECT COUNT(*)::int AS n FROM settings');
    assert.equal(settingsRows[0].n, 0, 'a fresh install must not create a settings row (that would wrongly look like legacy data to migrate)');
  } finally {
    await freshDb.close();
  }
});
