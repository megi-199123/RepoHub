'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: sioClient } = require('socket.io-client');
const { createApp } = require('../server/app');
const { openDatabase } = require('../server/db');
const { Store } = require('../server/store');

const ADMIN_PASSWORD = 'hunter2';
// Fire countdown timers fast in tests regardless of the requested seconds; the stored
// countdown_ends_at still reflects the real duration (see server/rooms/service.js).
const COUNTDOWN_MS_OVERRIDE = 150;

let server;
let base;
let db;
let closeApp;
let testStore;
const openSockets = [];

// Runs against an in-memory embedded Postgres by default.
// Set TEST_DATABASE_URL to run against a real (throwaway!) Postgres database.
before(async () => {
  db = await openDatabase({ databaseUrl: process.env.TEST_DATABASE_URL, memory: true });
  if (process.env.TEST_DATABASE_URL) {
    await db.query('DROP TABLE IF EXISTS room_boxes, room_players, rooms, settings, prizes, draws, rounds, admin_sessions, images');
  }
  const { app, ready, attach, close } = createApp({ db, adminPassword: ADMIN_PASSWORD, countdownMsOverride: COUNTDOWN_MS_OVERRIDE });
  closeApp = close;
  await ready;
  testStore = new Store(db);
  server = http.createServer(app);
  attach(server);
  await new Promise((resolve) => { server.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const s of openSockets) {
    try { s.disconnect(); } catch { /* already gone */ }
  }
  await closeApp();
  // Tolerant of ERR_SERVER_NOT_RUNNING: closeApp()/io.close() above already closed this server.
  await new Promise((resolve) => { server.close(() => resolve()); });
  await db.close();
});

/** Minimal cookie-keeping client, so each "browser" has its own visitor id. `ip` (if given) is
 *  sent as X-Forwarded-For, giving each test its own rate-limit bucket so failures in one test
 *  never spill into another (see server/rooms/service.js join rate limiting). */
function client(ip) {
  const jar = {};
  const req = async function request(method, url, body) {
    const headers = {
      'Content-Type': 'application/json',
      Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    };
    if (ip) headers['X-Forwarded-For'] = ip;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v) jar[k] = v;
      else delete jar[k];
    }
    const text = await res.text();
    return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  req.cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  return req;
}

async function adminReq() {
  const req = client('admin');
  const res = await req('POST', '/api/admin/login', { password: ADMIN_PASSWORD });
  assert.equal(res.status, 200);
  return req;
}

async function createRoom(admin, opts = {}) {
  const res = await admin('POST', '/api/admin/rooms', opts);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

function connectSocket(cookieHeader, targetBase = base) {
  return new Promise((resolve, reject) => {
    const socket = sioClient(targetBase, {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
      extraHeaders: cookieHeader ? { cookie: cookieHeader } : {},
    });
    openSockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/** Emits with an ack, rejecting instead of hanging forever if the server never acks. */
function emitAck(socket, event, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ack for "${event}" within ${timeoutMs}ms`)), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitFor(socket, event, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      if (predicate(payload)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
    }
    socket.on(event, handler);
  });
}

/** A raw join call outside the cookie-jar client, so T14 has full control over the X-Forwarded-For header. */
async function joinRaw(xff, body) {
  const res = await fetch(base + '/api/rooms/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

test('T1 admin creates rooms with distinct 6-digit codes', async () => {
  const admin = await adminReq();
  const a = await createRoom(admin, { boxCount: 4 });
  const b = await createRoom(admin, { boxCount: 4 });
  assert.match(a.code, /^\d{6}$/);
  assert.match(b.code, /^\d{6}$/);
  assert.notEqual(a.code, b.code);
  assert.equal(a.status, 'lobby');
  assert.equal(a.playerCount, 0);
  assert.equal(a.spectatorCount, 0);
});

test('T2 join validation', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 3 });
  const p = client('t2');

  assert.equal((await p('POST', '/api/rooms/join', { code: '12', name: 'Al' })).status, 400);
  assert.equal((await p('POST', '/api/rooms/join', { code: '999999', name: 'Al' })).status, 404);

  const first = await p('POST', '/api/rooms/join', { code: room.code, name: 'Al' });
  assert.equal(first.status, 200);
  assert.equal(first.body.role, 'player');

  const other = client('t2b');
  const taken = await other('POST', '/api/rooms/join', { code: room.code, name: 'al' }); // case-insensitive clash
  assert.equal(taken.status, 409);

  const again = await p('POST', '/api/rooms/join', { code: room.code, name: 'Al' });
  assert.equal(again.status, 200);
  assert.equal(again.body.playerId, first.body.playerId);
});

test('T3 seats: boxCount 2 + 3 joiners -> third is spectator; spectator cannot lock', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t3a');
  const b = client('t3b');
  const c = client('t3c');
  const ra = await a('POST', '/api/rooms/join', { code: room.code, name: 'A' });
  const rb = await b('POST', '/api/rooms/join', { code: room.code, name: 'B' });
  const rc = await c('POST', '/api/rooms/join', { code: room.code, name: 'C' });
  assert.equal(ra.body.role, 'player');
  assert.equal(rb.body.role, 'player');
  assert.equal(rc.body.role, 'spectator');

  const host = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host, 'room:join', { code: room.code, as: 'host' })).ok, true);
  assert.equal((await emitAck(host, 'host:action', { type: 'start' })).ok, true);

  const sc = await connectSocket(c.cookieHeader());
  assert.equal((await emitAck(sc, 'room:join', { code: room.code })).ok, true);
  const lockAck = await emitAck(sc, 'game:action', { type: 'lock', box: 0 });
  assert.equal(lockAck.ok, false);
});

test('T4 one lock per box under concurrency', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t4a');
  const b = client('t4b');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A4' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B4' });

  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(host, 'host:action', { type: 'start' });

  const sa = await connectSocket(a.cookieHeader());
  const sb = await connectSocket(b.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(sb, 'room:join', { code: room.code });

  const statePromise = waitFor(host, 'room:state', (v) => v.players.some((pl) => pl.lockedBox === 0));
  const [ra, rb] = await Promise.all([
    emitAck(sa, 'game:action', { type: 'lock', box: 0 }),
    emitAck(sb, 'game:action', { type: 'lock', box: 0 }),
  ]);
  const oks = [ra, rb].filter((r) => r.ok);
  const fails = [ra, rb].filter((r) => !r.ok);
  assert.equal(oks.length, 1);
  assert.equal(fails.length, 1);
  assert.equal(fails[0].error, 'That box is already taken');

  // PGlite serializes queries, so this proves the unique-index/SAVEPOINT logic, not a true
  // parallel race; it also passes against real Postgres with TEST_DATABASE_URL.
  const state = await statePromise;
  assert.equal(state.players.filter((pl) => pl.lockedBox === 0).length, 1);
});

test('T5 unlock + re-pick: lock moves 0->1, box 0 becomes lockable by the other player', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t5a');
  const b = client('t5b');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A5' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B5' });
  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(host, 'host:action', { type: 'start' });
  const sa = await connectSocket(a.cookieHeader());
  const sb = await connectSocket(b.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(sb, 'room:join', { code: room.code });

  assert.equal((await emitAck(sa, 'game:action', { type: 'lock', box: 0 })).ok, true);
  assert.equal((await emitAck(sa, 'game:action', { type: 'lock', box: 1 })).ok, true); // moves 0 -> 1
  const bLocksZero = await emitAck(sb, 'game:action', { type: 'lock', box: 0 });
  assert.equal(bLocksZero.ok, true);
});

test('T6 countdown expiry locks the room', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t6a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A6' });
  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(host, 'host:action', { type: 'start' });

  const lockedState = waitFor(host, 'room:state', (v) => v.status === 'locked');
  assert.equal((await emitAck(host, 'host:action', { type: 'countdown', seconds: 5 })).ok, true);
  await lockedState;

  const sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });
  const lockAck = await emitAck(sa, 'game:action', { type: 'lock', box: 0 });
  assert.equal(lockAck.ok, false);
});

test('T7 no dealt prize ids or claim codes leak before any reveal', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t7a');
  const b = client('t7b');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A7' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B7' });

  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  const sb = await connectSocket(b.cookieHeader());
  const seen = [];
  for (const s of [host, sa, sb]) s.on('room:state', (v) => seen.push(v));

  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(sb, 'room:join', { code: room.code });
  await emitAck(host, 'host:action', { type: 'start' });
  await emitAck(sa, 'game:action', { type: 'lock', box: 0 });

  const dbRoom = await testStore.getRoomByCode(room.code);
  assert.ok(Array.isArray(dbRoom.boxes) && dbRoom.boxes.length === 2);

  assert.ok(seen.length > 0);
  for (const state of seen) {
    const text = JSON.stringify(state);
    for (const prizeId of dbRoom.boxes) assert.ok(!text.includes(prizeId), `leaked prize id ${prizeId}`);
    assert.ok(!text.includes('MB-'), 'leaked a claim code');
  }
});

test('T8 reveal next twice then until finished', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 3 });
  const a = client('t8a');
  const b = client('t8b');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A8' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B8' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  const sb = await connectSocket(b.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(sb, 'room:join', { code: room.code });
  await emitAck(host, 'host:action', { type: 'start' });
  await emitAck(sa, 'game:action', { type: 'lock', box: 0 });
  await emitAck(sb, 'game:action', { type: 'lock', box: 1 });
  // box 2 stays unlocked

  let st = waitFor(host, 'room:state', (v) => v.boxes[0].revealed);
  assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'next' })).ok, true);
  let state = await st;
  assert.equal(state.boxes[0].revealed, true);
  assert.equal(state.boxes[1].revealed, false);
  assert.equal(state.status, 'revealing');

  st = waitFor(host, 'room:state', (v) => v.boxes[1].revealed);
  assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'next' })).ok, true);
  state = await st;
  assert.equal(state.boxes[1].revealed, true);
  assert.equal(state.status, 'revealing'); // box 2 (unlocked) still pending

  st = waitFor(host, 'room:state', (v) => v.status === 'finished');
  assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'next' })).ok, true);
  state = await st;
  assert.equal(state.status, 'finished');
  assert.ok(state.boxes.every((bx) => bx.revealed));
});

test('T9 stock only taken for locked boxes; exactly one draw row recorded', async () => {
  const admin = await adminReq();
  const originalPrizes = (await admin('GET', '/api/admin/prizes')).body;
  try {
    for (const p of originalPrizes) await admin('PUT', `/api/admin/prizes/${p.id}`, { stock: 50 });
    const stockBefore = Object.fromEntries((await admin('GET', '/api/admin/prizes')).body.map((p) => [p.id, p.stock]));

    const room = await createRoom(admin, { boxCount: 3 });
    const a = client('t9a');
    await a('POST', '/api/rooms/join', { code: room.code, name: 'A9' });
    const host = await connectSocket(admin.cookieHeader());
    const sa = await connectSocket(a.cookieHeader());
    await emitAck(host, 'room:join', { code: room.code, as: 'host' });
    await emitAck(sa, 'room:join', { code: room.code });
    await emitAck(host, 'host:action', { type: 'start' });
    await emitAck(sa, 'game:action', { type: 'lock', box: 0 });

    const drawsBefore = (await admin('GET', '/api/admin/draws')).body.length;
    const st = waitFor(host, 'room:state', (v) => v.status === 'finished');
    assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'all' })).ok, true);
    await st;

    const stockAfter = Object.fromEntries((await admin('GET', '/api/admin/prizes')).body.map((p) => [p.id, p.stock]));
    const drops = Object.keys(stockBefore).filter((id) => stockBefore[id] - stockAfter[id] === 1);
    const otherChanges = Object.keys(stockBefore).filter((id) => stockBefore[id] !== stockAfter[id] && stockBefore[id] - stockAfter[id] !== 1);
    assert.equal(
      drops.length,
      1,
      `expected exactly one prize's stock to drop by 1; before=${JSON.stringify(stockBefore)} after=${JSON.stringify(stockAfter)}`,
    );
    assert.equal(otherChanges.length, 0);

    const dbRoom = await testStore.getRoomByCode(room.code);
    const draws = (await admin('GET', '/api/admin/draws')).body;
    assert.equal(draws.length, drawsBefore + 1);
    const draw = draws.find((d) => d.roomId === dbRoom.id);
    assert.ok(draw, 'expected exactly one new draw tied to this room');
    assert.equal(draw.playerName, 'A9');
  } finally {
    for (const p of originalPrizes) await admin('PUT', `/api/admin/prizes/${p.id}`, { stock: p.stock });
  }
});

test('T10 claim-code privacy: only the winner sees their own claim code', async () => {
  const admin = await adminReq();
  const originalPrizes = (await admin('GET', '/api/admin/prizes')).body;
  const winner = originalPrizes.find((p) => p.winning);
  for (const p of originalPrizes) {
    await admin('PUT', `/api/admin/prizes/${p.id}`, { active: p.id === winner.id, stock: p.id === winner.id ? null : p.stock });
  }

  try {
    const room = await createRoom(admin, { boxCount: 2 });
    const a = client('t10a');
    const b = client('t10b');
    await a('POST', '/api/rooms/join', { code: room.code, name: 'A10' });
    await b('POST', '/api/rooms/join', { code: room.code, name: 'B10' });
    const host = await connectSocket(admin.cookieHeader());
    const sa = await connectSocket(a.cookieHeader());
    const sb = await connectSocket(b.cookieHeader());
    await emitAck(host, 'room:join', { code: room.code, as: 'host' });
    await emitAck(sa, 'room:join', { code: room.code });
    await emitAck(sb, 'room:join', { code: room.code });
    await emitAck(host, 'host:action', { type: 'start' });
    await emitAck(sa, 'game:action', { type: 'lock', box: 0 });

    const seenB = [];
    sb.on('room:state', (v) => seenB.push(v));
    const stA = waitFor(sa, 'room:state', (v) => v.me.claimCode);
    assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'all' })).ok, true);
    const stateA = await stA;
    assert.match(stateA.me.claimCode, /^MB-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    for (const v of seenB) assert.ok(!JSON.stringify(v).includes(stateA.me.claimCode));
  } finally {
    for (const p of originalPrizes) await admin('PUT', `/api/admin/prizes/${p.id}`, { active: p.active, stock: p.stock });
  }
});

test('T11 reconnect: same visitor keeps their lockedBox', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t11a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A11' });
  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(host, 'host:action', { type: 'start' });

  let sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });
  assert.equal((await emitAck(sa, 'game:action', { type: 'lock', box: 1 })).ok, true);
  sa.disconnect();

  sa = await connectSocket(a.cookieHeader());
  const statePromise = new Promise((resolve) => sa.once('room:state', resolve));
  const rejoin = await emitAck(sa, 'room:join', { code: room.code });
  assert.equal(rejoin.ok, true);
  const view = await statePromise;
  const mine = view.players.find((p) => p.id === view.me.id);
  assert.ok(mine, 'expected to find my own player entry');
  assert.equal(mine.lockedBox, 1);
});

test('T12 kick: kicked socket notified; REST re-join is 403', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t12');
  const joined = await a('POST', '/api/rooms/join', { code: room.code, name: 'A12' });
  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });

  const kicked = waitFor(sa, 'room:kicked');
  assert.equal((await emitAck(host, 'host:action', { type: 'kick', playerId: joined.body.playerId })).ok, true);
  await kicked;

  const rejoin = await a('POST', '/api/rooms/join', { code: room.code, name: 'A12' });
  assert.equal(rejoin.status, 403);
});

test('T13 lockJoins true blocks a new visitor with 423', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  assert.equal((await emitAck(host, 'host:action', { type: 'lockJoins', locked: true })).ok, true);

  const newcomer = client('t13');
  const res = await newcomer('POST', '/api/rooms/join', { code: room.code, name: 'New13' });
  assert.equal(res.status, 423);
});

test('T14 10 failed joins then 429, immune to leftmost X-Forwarded-For spoofing', async () => {
  for (let i = 0; i < 10; i++) {
    // A different spoofed leftmost hop each time; the rightmost hop ("127.0.0.1") stays constant.
    const res = await joinRaw(`1.2.3.${i}, 127.0.0.1`, { code: '000001', name: 'X' }); // no such room -> 404
    assert.equal(res.status, 404);
  }
  const blocked = await joinRaw('1.2.3.99, 127.0.0.1', { code: '000001', name: 'X' });
  assert.equal(blocked.status, 429);
});

test('T15 non-admin cannot join as host; a player cannot send host:action', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t15');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A15' });

  const notHost = await connectSocket(a.cookieHeader());
  const hostJoinAck = await emitAck(notHost, 'room:join', { code: room.code, as: 'host' });
  assert.equal(hostJoinAck.ok, false);

  const sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });
  const hostAction = await emitAck(sa, 'host:action', { type: 'close' });
  assert.equal(hostAction.ok, false);
});

test('T16 a second createApp instance on the same db sees the room and its locks', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t16');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A16' });
  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(host, 'host:action', { type: 'start' });
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });
  assert.equal((await emitAck(sa, 'game:action', { type: 'lock', box: 0 })).ok, true);

  const dbRoom = await testStore.getRoomByCode(room.code);
  const players = await testStore.listPlayers(dbRoom.id);
  assert.equal(players.find((p) => p.name === 'A16')?.lockedBox, 0);

  // Mirror server/index.js's production order: attach() is called before `ready` resolves, so
  // this also exercises the pendingIo hand-off in createApp (roomService doesn't exist yet when
  // attach() runs; the io reference must be stashed and handed to the service once it is built).
  const second = createApp({ db, adminPassword: ADMIN_PASSWORD });
  const server2 = http.createServer(second.app);
  second.attach(server2);
  await second.ready;
  await new Promise((resolve) => { server2.listen(0, resolve); });
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  try {
    const login = await fetch(`${base2}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const roomsRes = await fetch(`${base2}/api/admin/rooms`, { headers: { Cookie: cookie } });
    const rooms = await roomsRes.json();
    const found = rooms.find((r) => r.code === room.code);
    assert.ok(found, 'expected the second instance to see the room created by the first');
    assert.equal(found.status, 'picking');

    // Prove the pendingIo hand-off actually wired up realtime on this second instance too.
    const host2 = await connectSocket(cookie, base2);
    const statePromise = waitFor(host2, 'room:state', (v) => v.code === room.code);
    assert.equal((await emitAck(host2, 'room:join', { code: room.code, as: 'host' })).ok, true);
    const state = await statePromise;
    assert.equal(state.players.find((p) => p.name === 'A16')?.lockedBox, 0);
  } finally {
    await second.close();
    await new Promise((resolve) => { server2.close(() => resolve()); });
  }
});

test('T17 cursor relay excludes the sender and clamps to 0..1', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t17a');
  const b = client('t17b');
  const joinedA = await a('POST', '/api/rooms/join', { code: room.code, name: 'A17' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B17' });
  const sa = await connectSocket(a.cookieHeader());
  const sb = await connectSocket(b.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(sb, 'room:join', { code: room.code });

  let selfReceived = false;
  sa.on('cursor', () => { selfReceived = true; });
  const cursorPromise = waitFor(sb, 'cursor', (v) => v.playerId === joinedA.body.playerId);
  sa.emit('cursor:move', { b: 1, x: 2, y: -1 });
  const received = await cursorPromise;
  assert.equal(received.b, 1);
  assert.equal(received.x, 1);
  assert.equal(received.y, 0);

  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(selfReceived, false);
});

test('T18 reveal finishes when the last locked box is opened and none are unlocked', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t18a');
  const b = client('t18b');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A18' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B18' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  const sb = await connectSocket(b.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(sb, 'room:join', { code: room.code });
  await emitAck(host, 'host:action', { type: 'start' });
  await emitAck(sa, 'game:action', { type: 'lock', box: 0 });
  await emitAck(sb, 'game:action', { type: 'lock', box: 1 });
  // Both boxes locked; none unlocked — this is the case that must still finish after the last `next`.

  let st = waitFor(host, 'room:state', (v) => v.boxes[0].revealed);
  assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'next' })).ok, true);
  let state = await st;
  assert.equal(state.status, 'revealing');
  assert.equal(state.boxes[1].revealed, false);

  st = waitFor(host, 'room:state', (v) => v.status === 'finished');
  assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'next' })).ok, true);
  state = await st;
  assert.equal(state.status, 'finished');
  assert.ok(state.boxes.every((bx) => bx.revealed));
});

test('T19 kick promotion never exceeds boxCount, and updates an already-connected socket live', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const pa = client('t19a');
  const pb = client('t19b');
  const pc = client('t19c');
  const joinedA = await pa('POST', '/api/rooms/join', { code: room.code, name: 'A19' });
  await pb('POST', '/api/rooms/join', { code: room.code, name: 'B19' });
  const joinedC = await pc('POST', '/api/rooms/join', { code: room.code, name: 'C19' });
  assert.equal(joinedC.body.role, 'spectator');

  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  const sc = await connectSocket(pc.cookieHeader());
  await emitAck(sc, 'room:join', { code: room.code });

  // Kicking the spectator itself must never grow the player count past boxCount.
  const kickedSpectator = waitFor(sc, 'room:kicked');
  assert.equal((await emitAck(host, 'host:action', { type: 'kick', playerId: joinedC.body.playerId })).ok, true);
  await kickedSpectator;

  const pd = client('t19d');
  const joinedD = await pd('POST', '/api/rooms/join', { code: room.code, name: 'D19' });
  assert.equal(joinedD.body.role, 'spectator'); // A + B still hold both seats
  const sd = await connectSocket(pd.cookieHeader());
  const stateForD = waitFor(sd, 'room:state', (v) => v.me.role === 'spectator');
  assert.equal((await emitAck(sd, 'room:join', { code: room.code })).ok, true);
  await stateForD;

  // Kicking an actual player frees a seat: D must be promoted, and D's already-connected socket
  // must reflect it immediately via `me.role` — without reconnecting.
  const promoted = waitFor(sd, 'room:state', (v) => v.me.role === 'player');
  assert.equal((await emitAck(host, 'host:action', { type: 'kick', playerId: joinedA.body.playerId })).ok, true);
  const stateD = await promoted;
  assert.equal(stateD.players.filter((p) => p.role === 'player').length, 2);

  // D, now a player, must be able to act like one without reconnecting.
  await emitAck(host, 'host:action', { type: 'start' });
  const lockAck = await emitAck(sd, 'game:action', { type: 'lock', box: 0 });
  assert.equal(lockAck.ok, true);
});

test('T20 room draws do not consume the visitor solo play budget', async () => {
  const admin = await adminReq();
  const originalSettings = (await admin('GET', '/api/admin/settings')).body;
  try {
    assert.equal((await admin('PUT', '/api/admin/settings', { maxPlaysPerVisitor: 1 })).status, 200);

    const room = await createRoom(admin, { boxCount: 2 });
    const a = client('t20a');
    await a('POST', '/api/rooms/join', { code: room.code, name: 'A20' });
    const host = await connectSocket(admin.cookieHeader());
    const sa = await connectSocket(a.cookieHeader());
    await emitAck(host, 'room:join', { code: room.code, as: 'host' });
    await emitAck(sa, 'room:join', { code: room.code });
    await emitAck(host, 'host:action', { type: 'start' });
    await emitAck(sa, 'game:action', { type: 'lock', box: 0 });

    const st = waitFor(host, 'room:state', (v) => v.status === 'finished');
    assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'all' })).ok, true);
    await st;

    // The visitor now has a draw recorded (with room_id set) but must still have their full solo
    // play budget: room draws are a different pool from the solo /api/rounds plays.
    const config = await a('GET', '/api/config');
    assert.equal(config.body.playsLeft, 1, 'a room draw must not consume the visitor solo play budget');
  } finally {
    assert.equal((await admin('PUT', '/api/admin/settings', originalSettings)).status, 200);
  }
});

test('T21 reveal on an already-finished room is rejected, not a silent no-op', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t21a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A21' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(host, 'host:action', { type: 'start' });
  await emitAck(sa, 'game:action', { type: 'lock', box: 0 });

  const st = waitFor(host, 'room:state', (v) => v.status === 'finished');
  assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'all' })).ok, true);
  await st;

  const again = await emitAck(host, 'host:action', { type: 'reveal', mode: 'all' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'The reveal is already complete');
});

test('T22 a non-function ack does not crash the server; it keeps answering afterwards', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t22a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A22' });

  const host = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host, 'room:join', { code: room.code, as: 'host' })).ok, true);
  const sa = await connectSocket(a.cookieHeader());
  assert.equal((await emitAck(sa, 'room:join', { code: room.code })).ok, true);

  // A client passing a non-function ack (e.g. a number) must not crash the process — for any of
  // the three handlers that reply with an ack. `stray` is a fresh, not-yet-joined socket so its
  // room:join call doesn't disturb host/sa's already-established state used below.
  const stray = await connectSocket(a.cookieHeader());
  stray.emit('room:join', { code: room.code }, 1);
  sa.emit('game:action', { type: 'lock', box: 0 }, 1);
  host.emit('host:action', { type: 'lockJoins', locked: false }, 1);

  await new Promise((resolve) => { setTimeout(resolve, 150); });

  // The server must still be alive and answering both realtime and REST requests.
  assert.equal((await emitAck(host, 'host:action', { type: 'lockJoins', locked: true })).ok, true);
  const health = await fetch(base + '/healthz');
  assert.equal(health.status, 200);
});

test('T23 a malformed cookie on the socket handshake does not crash the server', async () => {
  // "a=%" is a malformed percent-escape; decodeURIComponent throws on it if not guarded.
  const socket = await connectSocket('a=%');
  const ack = await emitAck(socket, 'room:join', { code: '123456' });
  assert.equal(ack.ok, false); // no mb_visitor cookie -> treated as an anonymous, out-of-room visitor

  const health = await fetch(base + '/healthz');
  assert.equal(health.status, 200);

  // The rest of the server (DB-backed routes, not just the liveness probe) must still work too.
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  assert.match(room.code, /^\d{6}$/);
});

test('T24 10 name-taken 409s from one IP do not produce a 429', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 4 });
  const seeded = await client('t24seed')('POST', '/api/rooms/join', { code: room.code, name: 'Taken24' });
  assert.equal(seeded.status, 200);

  // A distinct rightmost X-Forwarded-For hop from every other rate-limit test in this file (T14
  // uses 127.0.0.1), so this test's bucket can't collide with one already blocked elsewhere.
  const xff = '203.0.113.24';
  for (let i = 0; i < 10; i++) {
    const res = await joinRaw(xff, { code: room.code, name: 'Taken24' }); // name already taken -> 409
    assert.equal(res.status, 409);
  }
  const ok = await joinRaw(xff, { code: room.code, name: 'Fresh24' });
  assert.equal(ok.status, 200, 'a run of 409s (proof the code is real) must never trip the join rate limit');
});

test('T25 host:action re-checks the admin session; a revoked one is downgraded, not just refused once', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const host = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host, 'room:join', { code: room.code, as: 'host' })).ok, true);
  assert.equal((await emitAck(host, 'host:action', { type: 'lockJoins', locked: true })).ok, true);

  const logout = await admin('POST', '/api/admin/logout');
  assert.equal(logout.status, 200);

  const afterLogout = await emitAck(host, 'host:action', { type: 'lockJoins', locked: false });
  assert.equal(afterLogout.ok, false);
  assert.equal(afterLogout.error, 'Please sign in');

  // The socket's cached host role must be downgraded, not just this one call refused.
  const again = await emitAck(host, 'host:action', { type: 'close' });
  assert.equal(again.ok, false);
});
