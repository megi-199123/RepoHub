'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: sioClient } = require('socket.io-client');
const { createApp } = require('../server/app');
const { openDatabase } = require('../server/db');
const { Store } = require('../server/store');
const { RoomService } = require('../server/rooms/service');
const games = require('../server/games');

const ADMIN_PASSWORD = 'hunter2';
// Fire countdown timers fast in tests regardless of the requested seconds; the stored
// countdown_ends_at still reflects the real duration (see server/rooms/service.js).
const COUNTDOWN_MS_OVERRIDE = 150;

let server;
let base;
let db;
let closeApp;
let testStore;
let ioMain;
const openSockets = [];

// Runs against an in-memory embedded Postgres by default.
// Set TEST_DATABASE_URL to run them against a real (throwaway!) Postgres database.
before(async () => {
  db = await openDatabase({ databaseUrl: process.env.TEST_DATABASE_URL, memory: true });
  if (process.env.TEST_DATABASE_URL) {
    await db.query(
      'DROP TABLE IF EXISTS room_messages, room_boxes, room_players, rooms, settings, prizes, draws, rounds, admin_sessions, images, user_sessions, users',
    );
  }
  const { app, ready, attach, close } = createApp({ db, adminPassword: ADMIN_PASSWORD, countdownMsOverride: COUNTDOWN_MS_OVERRIDE });
  closeApp = close;
  await ready;
  testStore = new Store(db);
  server = http.createServer(app);
  ioMain = attach(server);
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

/** Minimal cookie-keeping client, so each "browser" has its own visitor id / session. `ip` (if
 *  given) is sent as X-Forwarded-For, giving each test its own rate-limit bucket so failures in
 *  one test never spill into another (see server/rooms/service.js join rate limiting). */
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

async function login(email, password) {
  const req = client();
  const res = await req('POST', '/api/auth/login', { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return req;
}

async function adminReq() {
  return login('admin', ADMIN_PASSWORD);
}

async function createRoom(admin, opts = {}) {
  const res = await admin('POST', '/api/admin/rooms', { type: 'managed', ...opts });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function createDefaultRoom(admin, opts = {}) {
  const res = await admin('POST', '/api/admin/rooms', { type: 'default', ...opts });
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
  assert.equal(a.type, 'managed');
  assert.equal(a.playerCount, 0);
  assert.equal(a.spectatorCount, 0);
  assert.equal(a.prizeCount, 4);
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
  assert.equal(first.body.type, 'managed');

  const other = client('t2b');
  const taken = await other('POST', '/api/rooms/join', { code: room.code, name: 'al' }); // case-insensitive clash
  assert.equal(taken.status, 409);

  const again = await p('POST', '/api/rooms/join', { code: room.code, name: 'Al' });
  assert.equal(again.status, 200);
  assert.equal(again.body.playerId, first.body.playerId);
});

test('T2b join with no name returns needsName without counting as a failure', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 3 });
  const noName = await joinRaw('203.0.113.2', { code: room.code });
  assert.equal(noName.status, 200);
  assert.equal(noName.body.needsName, true);
  assert.equal(noName.body.type, 'managed');
});

test('T3 seats: boxCount 2 + a 3rd joiner gets 409 canWatch; watching lets them in as a spectator who cannot lock', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t3a');
  const b = client('t3b');
  const c = client('t3c');
  const ra = await a('POST', '/api/rooms/join', { code: room.code, name: 'A' });
  const rb = await b('POST', '/api/rooms/join', { code: room.code, name: 'B' });
  assert.equal(ra.body.role, 'player');
  assert.equal(rb.body.role, 'player');

  // Seats full: join no longer falls back to spectating — it says so, with canWatch.
  const rc = await c('POST', '/api/rooms/join', { code: room.code, name: 'C' });
  assert.equal(rc.status, 409);
  assert.equal(rc.body.canWatch, true);
  assert.match(rc.body.error, /All seats are taken/);

  // Watching is a separate, explicit call.
  const watched = await c('POST', '/api/rooms/watch', { code: room.code });
  assert.equal(watched.status, 200);
  assert.deepEqual(watched.body, { code: room.code, type: 'managed', role: 'spectator' });

  const host = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host, 'room:join', { code: room.code, as: 'host' })).ok, true);
  assert.equal((await emitAck(host, 'host:action', { type: 'start' })).ok, true);

  const sc = await connectSocket(c.cookieHeader());
  const stateForC = waitFor(sc, 'room:state', (v) => v.me.role === 'spectator');
  assert.equal((await emitAck(sc, 'room:join', { code: room.code })).ok, true);
  const stateC = await stateForC;
  assert.equal(stateC.spectatorCount, 1);
  assert.equal(stateC.players.length, 2, 'the players roster must list seated players only');
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
  const room = await createRoom(admin, { boxCount: 3 });
  const originalPrizes = (await admin('GET', `/api/admin/rooms/${room.id}/prizes`)).body;
  for (const p of originalPrizes) await admin('PUT', `/api/admin/rooms/${room.id}/prizes/${p.id}`, { stock: 50 });
  const stockBefore = Object.fromEntries((await admin('GET', `/api/admin/rooms/${room.id}/prizes`)).body.map((p) => [p.id, p.stock]));

  const a = client('t9a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A9' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(host, 'host:action', { type: 'start' });
  await emitAck(sa, 'game:action', { type: 'lock', box: 0 });

  const drawsBefore = (await admin('GET', `/api/admin/draws?roomId=${room.id}`)).body.length;
  const st = waitFor(host, 'room:state', (v) => v.status === 'finished');
  assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'all' })).ok, true);
  await st;

  const stockAfter = Object.fromEntries((await admin('GET', `/api/admin/rooms/${room.id}/prizes`)).body.map((p) => [p.id, p.stock]));
  const drops = Object.keys(stockBefore).filter((id) => stockBefore[id] - stockAfter[id] === 1);
  const otherChanges = Object.keys(stockBefore).filter((id) => stockBefore[id] !== stockAfter[id] && stockBefore[id] - stockAfter[id] !== 1);
  assert.equal(
    drops.length,
    1,
    `expected exactly one prize's stock to drop by 1; before=${JSON.stringify(stockBefore)} after=${JSON.stringify(stockAfter)}`,
  );
  assert.equal(otherChanges.length, 0);

  const draws = (await admin('GET', `/api/admin/draws?roomId=${room.id}`)).body;
  assert.equal(draws.length, drawsBefore + 1);
  const draw = draws.find((d) => d.roomId === room.id);
  assert.ok(draw, 'expected exactly one new draw tied to this room');
  assert.equal(draw.playerName, 'A9');
});

test('T10 claim-code privacy: only the winner sees their own claim code', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const originalPrizes = (await admin('GET', `/api/admin/rooms/${room.id}/prizes`)).body;
  const winner = originalPrizes.find((p) => p.winning);
  for (const p of originalPrizes) {
    await admin('PUT', `/api/admin/rooms/${room.id}/prizes/${p.id}`, { active: p.id === winner.id, stock: p.id === winner.id ? null : p.stock });
  }

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

  // The limiter is shared across every by-code public endpoint, not just /api/rooms/join.
  const configBlocked = await fetch(`${base}/api/rooms/000001/config`, {
    headers: { 'X-Forwarded-For': '1.2.3.99, 127.0.0.1' },
  });
  assert.equal(configBlocked.status, 429);
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
    const login2 = await fetch(`${base2}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin', password: ADMIN_PASSWORD }),
    });
    assert.equal(login2.status, 200);
    const cookie = login2.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
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

test('T19 kick does not promote a spectator into the freed seat (A2): they must join again with a name', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const pa = client('t19a');
  const pb = client('t19b');
  const pc = client('t19c');
  const joinedA = await pa('POST', '/api/rooms/join', { code: room.code, name: 'A19' });
  await pb('POST', '/api/rooms/join', { code: room.code, name: 'B19' });
  const watchedC = await pc('POST', '/api/rooms/watch', { code: room.code });
  assert.equal(watchedC.body.role, 'spectator');

  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  const sc = await connectSocket(pc.cookieHeader());
  const stateForC = waitFor(sc, 'room:state', (v) => v.me.role === 'spectator');
  await emitAck(sc, 'room:join', { code: room.code });
  await stateForC;

  // Kicking a seated player frees a seat, but C (already watching) must NOT be auto-promoted.
  const noLongerHasA = waitFor(host, 'room:state', (v) => v.players.length === 1);
  assert.equal((await emitAck(host, 'host:action', { type: 'kick', playerId: joinedA.body.playerId })).ok, true);
  const stateAfterKick = await noLongerHasA;
  assert.equal(stateAfterKick.players.filter((p) => p.role === 'player').length, 1);
  // C's cached role must still read spectator — no live promotion happened.
  const stillWatching = await emitAck(sc, 'game:action', { type: 'lock', box: 0 });
  assert.equal(stillWatching.ok, false);

  // C must actively rejoin with a name to take the freed seat.
  const rejoin = await pc('POST', '/api/rooms/join', { code: room.code, name: 'C19' });
  assert.equal(rejoin.status, 200);
  assert.equal(rejoin.body.role, 'player');

  const nowPlaying = waitFor(sc, 'room:state', (v) => v.me.role === 'player');
  await emitAck(sc, 'room:join', { code: room.code }); // reconnect to pick up the upgraded role
  const stateD = await nowPlaying;
  assert.equal(stateD.players.filter((p) => p.role === 'player').length, 2);

  await emitAck(host, 'host:action', { type: 'start' });
  const lockAck = await emitAck(sc, 'game:action', { type: 'lock', box: 0 });
  assert.equal(lockAck.ok, true);
});

test('T20 plays-per-visitor is scoped per room: a managed-room draw never touches a default room\'s budget', async () => {
  const admin = await adminReq();
  const defaultRoom = await createDefaultRoom(admin, { maxPlaysPerVisitor: 1 });
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

  // The visitor now has a draw recorded against the managed room, but the default room's own
  // plays-per-visitor budget is a completely separate (visitor, room_id) count.
  const config = await a('GET', `/api/rooms/${defaultRoom.code}/config`);
  assert.equal(config.body.playsLeft, 1, "a different room's draw must not consume this room's play budget");
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

test('T25 host:action re-checks the session and ownership; a revoked one is downgraded, not just refused once', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const host = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host, 'room:join', { code: room.code, as: 'host' })).ok, true);
  assert.equal((await emitAck(host, 'host:action', { type: 'lockJoins', locked: true })).ok, true);

  const logout = await admin('POST', '/api/auth/logout');
  assert.equal(logout.status, 200);

  const afterLogout = await emitAck(host, 'host:action', { type: 'lockJoins', locked: false });
  assert.equal(afterLogout.ok, false);
  assert.equal(afterLogout.error, 'Please sign in');

  // The socket's cached host role must be downgraded, not just this one call refused.
  const again = await emitAck(host, 'host:action', { type: 'close' });
  assert.equal(again.ok, false);
});

test('T26 unlock frees the box for another player; unlock outside picking is rejected', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t26a');
  const b = client('t26b');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A26' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B26' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  const sb = await connectSocket(b.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(sb, 'room:join', { code: room.code });

  // Still in the lobby: unlock has nothing to release and must fail, not silently succeed.
  const tooEarly = await emitAck(sa, 'game:action', { type: 'unlock' });
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.error, 'Boxes are not open for picking right now');

  await emitAck(host, 'host:action', { type: 'start' });
  assert.equal((await emitAck(sa, 'game:action', { type: 'lock', box: 0 })).ok, true);

  const freed = waitFor(host, 'room:state', (v) => v.players.every((p) => p.lockedBox === null));
  assert.equal((await emitAck(sa, 'game:action', { type: 'unlock' })).ok, true);
  await freed;

  // Box 0 is free again: another player can now lock it.
  assert.equal((await emitAck(sb, 'game:action', { type: 'lock', box: 0 })).ok, true);

  // Once the countdown locks the room, unlock is rejected there too (not just pre-start).
  const locked = waitFor(host, 'room:state', (v) => v.status === 'locked');
  assert.equal((await emitAck(host, 'host:action', { type: 'countdown', seconds: 5 })).ok, true);
  await locked;
  const tooLate = await emitAck(sb, 'game:action', { type: 'unlock' });
  assert.equal(tooLate.ok, false);
  assert.equal(tooLate.error, 'Boxes are not open for picking right now');
});

test('T27 countdown re-arm: a past countdown_ends_at is applied immediately by a new instance', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const host = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host, 'room:join', { code: room.code, as: 'host' })).ok, true);
  assert.equal((await emitAck(host, 'host:action', { type: 'start' })).ok, true);

  const dbRoom = await testStore.getRoomByCode(room.code);
  assert.equal(dbRoom.status, 'picking');
  // Backdate directly via SQL rather than the 'countdown' host action: going through the action
  // would arm (and, thanks to COUNTDOWN_MS_OVERRIDE, immediately fire) a timer on THIS instance,
  // which is exactly what this test must avoid — it's testing a *second* instance's re-arm.
  await db.query("UPDATE rooms SET countdown_ends_at = now() - interval '5 seconds' WHERE id = $1", [dbRoom.id]);

  const second = createApp({ db, adminPassword: ADMIN_PASSWORD });
  await second.ready;
  try {
    let status;
    for (let i = 0; i < 40; i++) {
      status = (await testStore.getRoom(dbRoom.id)).status;
      if (status === 'locked') break;
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    assert.equal(status, 'locked', 'expected _rearmCountdowns to apply an already-past countdown immediately');
  } finally {
    await second.close();
  }
});

test('T28 countdown re-arm: a still-pending countdown is re-armed by a new instance and fires', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const host = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host, 'room:join', { code: room.code, as: 'host' })).ok, true);
  assert.equal((await emitAck(host, 'host:action', { type: 'start' })).ok, true);

  const dbRoom = await testStore.getRoomByCode(room.code);
  // Genuinely in the future — not yet due — so this proves a re-arm, not just a past-deadline catch-up.
  await db.query("UPDATE rooms SET countdown_ends_at = now() + interval '1 hour' WHERE id = $1", [dbRoom.id]);

  // The override hook still applies across a restart: the stored countdown_ends_at keeps the real
  // duration, but the re-armed timer fires fast like every other timer in this suite.
  const second = createApp({ db, adminPassword: ADMIN_PASSWORD, countdownMsOverride: COUNTDOWN_MS_OVERRIDE });
  await second.ready;
  try {
    let status;
    for (let i = 0; i < 40; i++) {
      status = (await testStore.getRoom(dbRoom.id)).status;
      if (status === 'locked') break;
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    assert.equal(status, 'locked', 'expected the re-armed countdown to fire via the override hook');
  } finally {
    await second.close();
  }
});

test('T29 sweep closes stale rooms (by last_activity_at or finished_at) and notifies connected sockets; a fresh room is untouched; a default room is never swept', async () => {
  const admin = await adminReq();

  const roomA = await createRoom(admin, { boxCount: 2 }); // left stale in 'lobby'
  const hostA = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(hostA, 'room:join', { code: roomA.code, as: 'host' })).ok, true);

  const roomB = await createRoom(admin, { boxCount: 2 }); // driven to 'finished' with no locks, then aged
  const hostB = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(hostB, 'room:join', { code: roomB.code, as: 'host' })).ok, true);
  await emitAck(hostB, 'host:action', { type: 'start' });
  const finishedState = waitFor(hostB, 'room:state', (v) => v.status === 'finished');
  assert.equal((await emitAck(hostB, 'host:action', { type: 'reveal', mode: 'all' })).ok, true);
  await finishedState;

  const roomC = await createRoom(admin, { boxCount: 2 }); // fresh: must survive the sweep
  const roomD = await createDefaultRoom(admin); // persistent: must survive the sweep even when stale

  const dbA = await testStore.getRoomByCode(roomA.code);
  const dbB = await testStore.getRoomByCode(roomB.code);
  const dbC = await testStore.getRoomByCode(roomC.code);
  await db.query("UPDATE rooms SET last_activity_at = now() - interval '3 hours' WHERE id = $1", [dbA.id]);
  await db.query("UPDATE rooms SET finished_at = now() - interval '31 minutes' WHERE id = $1", [dbB.id]);
  await db.query("UPDATE rooms SET last_activity_at = now() - interval '3 hours' WHERE id = $1", [roomD.id]);

  // A second, throwaway RoomService pointed at the same store, wired to the SAME io as the main
  // test server (so `io.to(room)` reaches the already-connected hostA/hostB sockets) — this lets
  // the test invoke sweep() directly instead of waiting out the real 60s interval.
  const sweepService = new RoomService({ store: testStore, games });
  sweepService.setIo(ioMain);
  try {
    const closedA = waitFor(hostA, 'room:closed');
    const closedB = waitFor(hostB, 'room:closed');
    await sweepService.sweep();
    await closedA;
    await closedB;
  } finally {
    sweepService.shutdown();
  }

  assert.equal((await testStore.getRoom(dbA.id)).status, 'closed');
  assert.equal((await testStore.getRoom(dbB.id)).status, 'closed');
  assert.equal((await testStore.getRoom(dbC.id)).status, 'lobby', 'a fresh room must not be swept');
  assert.equal((await testStore.getRoom(roomD.id)).status, 'open', 'a default room must never be swept');
});

test('T30 CSV export includes a Room column with the room code for a room draw', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t30a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A30' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(host, 'host:action', { type: 'start' });
  await emitAck(sa, 'game:action', { type: 'lock', box: 0 });

  const st = waitFor(host, 'room:state', (v) => v.status === 'finished');
  assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'all' })).ok, true);
  await st;

  const csv = await admin('GET', `/api/admin/draws.csv?roomId=${room.id}`);
  assert.equal(csv.status, 200);
  assert.match(csv.body, /^"Date","Claim code","Prize","Redeemed","Redeemed at","Player","Room"/);

  const lines = csv.body.trim().split('\n');
  const roomRow = lines.find((l) => l.includes('"A30"'));
  assert.ok(roomRow, 'expected a CSV row for the room draw');
  assert.ok(roomRow.endsWith(`"${room.code}"`), `expected the row to end with the room code, got: ${roomRow}`);
});

test('T31 a room reveal never draws another room\'s prize', async () => {
  const admin = await adminReq();
  const roomA = await createRoom(admin, { boxCount: 2 });
  const roomB = await createRoom(admin, { boxCount: 2 });

  for (const p of (await admin('GET', `/api/admin/rooms/${roomA.id}/prizes`)).body) {
    await admin('PUT', `/api/admin/rooms/${roomA.id}/prizes/${p.id}`, { active: false });
  }
  await admin('POST', `/api/admin/rooms/${roomA.id}/prizes`, { name: 'OnlyInA', weight: 1, stock: 100 });

  for (const p of (await admin('GET', `/api/admin/rooms/${roomB.id}/prizes`)).body) {
    await admin('PUT', `/api/admin/rooms/${roomB.id}/prizes/${p.id}`, { active: false });
  }
  await admin('POST', `/api/admin/rooms/${roomB.id}/prizes`, { name: 'OnlyInB', weight: 1, stock: 100 });

  const a = client('t31a');
  await a('POST', '/api/rooms/join', { code: roomA.code, name: 'A31' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(host, 'room:join', { code: roomA.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: roomA.code });
  await emitAck(host, 'host:action', { type: 'start' });
  await emitAck(sa, 'game:action', { type: 'lock', box: 0 });

  const st = waitFor(host, 'room:state', (v) => v.status === 'finished');
  assert.equal((await emitAck(host, 'host:action', { type: 'reveal', mode: 'all' })).ok, true);
  const state = await st;

  assert.equal(state.boxes[0].prize.name, 'OnlyInA');
  const draws = (await admin('GET', `/api/admin/draws?roomId=${roomA.id}`)).body;
  assert.ok(draws.every((d) => d.prizeName !== 'OnlyInB'));
});

test('T32 tenant isolation: user B cannot host user A\'s room over the socket (404, not 403)', async () => {
  const admin = await adminReq();
  const roomA = await createRoom(admin, { boxCount: 2 });

  const bCreds = { email: 'iso-socket-b@example.com', name: 'Iso Socket B', password: 'longenough1' };
  assert.equal((await admin('POST', '/api/admin/users', bCreds)).status, 201);
  const b = await login(bCreds.email, bCreds.password);

  const bHost = await connectSocket(b.cookieHeader());
  const ack = await emitAck(bHost, 'room:join', { code: roomA.code, as: 'host' });
  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'Room not found');

  // A's own session still hosts it fine.
  const aHost = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(aHost, 'room:join', { code: roomA.code, as: 'host' })).ok, true);
});

test('T34 a managed room past the lobby refuses style/countdown/assignment, but boxCount (A1) and title/subtitle/showPrizes stay editable through picking', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const host = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host, 'room:join', { code: room.code, as: 'host' })).ok, true);
  assert.equal((await emitAck(host, 'host:action', { type: 'start' })).ok, true);

  const blockedStyle = await admin('PUT', `/api/admin/rooms/${room.id}`, { style: 'chest' });
  assert.equal(blockedStyle.status, 409);
  assert.match(blockedStyle.body.error, /already started/);

  const blockedAssignment = await admin('PUT', `/api/admin/rooms/${room.id}`, { assignment: 'weighted' });
  assert.equal(blockedAssignment.status, 409);

  // Addendum A1: boxCount is now allowed during picking too — it re-deals instead of 409ing.
  const boxCountOk = await admin('PUT', `/api/admin/rooms/${room.id}`, { boxCount: 3 });
  assert.equal(boxCountOk.status, 200);
  assert.equal(boxCountOk.body.boxCount, 3);

  const ok = await admin('PUT', `/api/admin/rooms/${room.id}`, { title: 'Still editable', showPrizes: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, 'Still editable');
  assert.equal(ok.body.showPrizes, false);
});

test('T33 room:join for a default room is refused for host and player alike', async () => {
  const admin = await adminReq();
  const room = await createDefaultRoom(admin);

  const hostAck = await emitAck(await connectSocket(admin.cookieHeader()), 'room:join', { code: room.code, as: 'host' });
  assert.equal(hostAck.ok, false);
  assert.equal(hostAck.error, 'This room has no live board');

  // Needs a real mb_visitor cookie first — without one, "not a member" fires before the type check.
  const player = client('t33');
  await player('GET', `/api/rooms/${room.code}/config`);
  const playerAck = await emitAck(await connectSocket(player.cookieHeader()), 'room:join', { code: room.code });
  assert.equal(playerAck.ok, false);
  assert.equal(playerAck.error, 'This room has no live board');
});

// ---------- Addendum A: live box count + separate player/watch links ----------

test('T35 setBoxCount in the lobby grows and shrinks the room, via socket and REST', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 4 });
  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });

  const grown = waitFor(host, 'room:state', (v) => v.boxCount === 6);
  assert.equal((await emitAck(host, 'host:action', { type: 'setBoxCount', count: 6 })).ok, true);
  assert.equal((await grown).boxCount, 6);

  const shrunk = waitFor(host, 'room:state', (v) => v.boxCount === 3);
  assert.equal((await emitAck(host, 'host:action', { type: 'setBoxCount', count: 3 })).ok, true);
  assert.equal((await shrunk).boxCount, 3);

  const viaRest = await admin('PUT', `/api/admin/rooms/${room.id}`, { boxCount: 5 });
  assert.equal(viaRest.status, 200);
  assert.equal(viaRest.body.boxCount, 5);
});

test('T36 setBoxCount during picking re-deals from this room\'s own prizes and releases the lock on a removed box', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 3 });
  const a = client('t36a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A36' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(host, 'host:action', { type: 'start' });

  // Lock box 2 — the one about to fall off the end when we shrink to 2 boxes.
  assert.equal((await emitAck(sa, 'game:action', { type: 'lock', box: 2 })).ok, true);

  const shrunk = waitFor(host, 'room:state', (v) => v.boxCount === 2);
  assert.equal((await emitAck(host, 'host:action', { type: 'setBoxCount', count: 2 })).ok, true);
  const state = await shrunk;
  assert.equal(state.boxes.length, 2);
  assert.ok(state.players.every((p) => p.lockedBox === null), 'the lock on the removed box (2) must be released');

  const dbRoomAfter = await testStore.getRoom(room.id);
  assert.equal(dbRoomAfter.boxes.length, 2);
  const prizeIds = new Set((await testStore.listPrizes(room.id)).map((p) => p.id));
  for (const id of dbRoomAfter.boxes) assert.ok(prizeIds.has(id), 're-deal must draw only from this room\'s own prizes');

  // The player can lock again within the new range.
  assert.equal((await emitAck(sa, 'game:action', { type: 'lock', box: 1 })).ok, true);
});

test('T37 setBoxCount below the seated count is refused, and so is any change once locked-in', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 3 });
  const a = client('t37a');
  const b = client('t37b');
  const c = client('t37c');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A37' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B37' });
  await c('POST', '/api/rooms/join', { code: room.code, name: 'C37' });

  // 3 seated; 2 is a valid boxCount (range 2-12) but below the seated count.
  const tooFew = await admin('PUT', `/api/admin/rooms/${room.id}`, { boxCount: 2 });
  assert.equal(tooFew.status, 409);
  assert.match(tooFew.body.error, /players are seated/);

  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(host, 'host:action', { type: 'start' });
  const locked = waitFor(host, 'room:state', (v) => v.status === 'locked');
  assert.equal((await emitAck(host, 'host:action', { type: 'countdown', seconds: 5 })).ok, true);
  await locked;

  const afterLock = await emitAck(host, 'host:action', { type: 'setBoxCount', count: 4 });
  assert.equal(afterLock.ok, false);
  assert.equal(afterLock.error, 'Boxes are already locked in');
});

test('T38 setBoxCount is refused for a non-owner: a foreign tenant can\'t reach it, a mid-session ownership change is caught, and a revoked session is re-checked too', async () => {
  const admin = await adminReq();
  const aId = (await admin('GET', '/api/auth/me')).body.user.id;
  const room = await createRoom(admin, { boxCount: 3 });

  const bCreds = { email: 'iso-boxcount-b@example.com', name: 'Iso BoxCount B', password: 'longenough1' };
  const bId = (await admin('POST', '/api/admin/users', bCreds)).body.id;
  const b = await login(bCreds.email, bCreds.password);

  // B can't even become host of A's room (ownership is checked at room:join) — so setBoxCount is
  // unreachable for a genuinely foreign tenant. Confirm both the socket and REST doors are shut.
  const bHost = await connectSocket(b.cookieHeader());
  assert.equal((await emitAck(bHost, 'room:join', { code: room.code, as: 'host' })).ok, false);
  assert.equal((await b('PUT', `/api/admin/rooms/${room.id}`, { boxCount: 5 })).status, 404);

  // Falsify the ownership branch directly: A is already hosting, then the room's owner_id changes
  // out from under that live socket (e.g. a future transfer feature) — the next host:action must
  // re-check ownership against the CURRENT row, not trust what room:join saw.
  const host = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host, 'room:join', { code: room.code, as: 'host' })).ok, true);
  await db.query('UPDATE rooms SET owner_id = $1 WHERE id = $2', [bId, room.id]);
  const afterOwnerChange = await emitAck(host, 'host:action', { type: 'setBoxCount', count: 5 });
  assert.equal(afterOwnerChange.ok, false);
  assert.equal(afterOwnerChange.error, 'Please sign in');
  await db.query('UPDATE rooms SET owner_id = $1 WHERE id = $2', [aId, room.id]); // restore

  // And the session-revoked case (mirrors T25, which only exercised lockJoins/close).
  const host2 = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(host2, 'room:join', { code: room.code, as: 'host' })).ok, true);
  await admin('POST', '/api/auth/logout');
  const afterLogout = await emitAck(host2, 'host:action', { type: 'setBoxCount', count: 5 });
  assert.equal(afterLogout.ok, false);
  assert.equal(afterLogout.error, 'Please sign in');
});

test('T39 join once seats are full, or once the game is revealing/finished, gives 409 canWatch (never a silent spectator fallback)', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t39a');
  const b = client('t39b');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A39' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B39' });

  const c = client('t39c');
  const fullSeats = await c('POST', '/api/rooms/join', { code: room.code, name: 'C39' });
  assert.equal(fullSeats.status, 409);
  assert.equal(fullSeats.body.canWatch, true);
  assert.match(fullSeats.body.error, /All seats are taken/);

  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(host, 'host:action', { type: 'start' });
  await emitAck(sa, 'game:action', { type: 'lock', box: 0 });
  const st = waitFor(host, 'room:state', (v) => v.status === 'finished');
  await emitAck(host, 'host:action', { type: 'reveal', mode: 'all' });
  await st;

  const d = client('t39d');
  const gameOver = await d('POST', '/api/rooms/join', { code: room.code, name: 'D39' });
  assert.equal(gameOver.status, 409);
  assert.equal(gameOver.body.canWatch, true);
  assert.match(gameOver.body.error, /game is over/);

  const watched = await d('POST', '/api/rooms/watch', { code: room.code });
  assert.equal(watched.status, 200);
  assert.equal(watched.body.role, 'spectator');
});

test('T40 watch creates a spectator row (idempotently) and the watcher\'s socket joins the room as a spectator', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const w = client('t40w');

  const res = await w('POST', '/api/rooms/watch', { code: room.code });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { code: room.code, type: 'managed', role: 'spectator' });

  const again = await w('POST', '/api/rooms/watch', { code: room.code });
  assert.deepEqual(again.body, res.body, 'a second watch call for the same visitor must reuse the row, not duplicate it');

  const ws = await connectSocket(w.cookieHeader());
  const statePromise = new Promise((resolve) => ws.once('room:state', resolve));
  assert.equal((await emitAck(ws, 'room:join', { code: room.code })).ok, true);
  const state = await statePromise;
  assert.equal(state.me.role, 'spectator');
  assert.equal(state.spectatorCount, 1);
  assert.equal(state.players.length, 0);
});

test('T41 watch on a default room is refused with "no live board"', async () => {
  const admin = await adminReq();
  const room = await createDefaultRoom(admin);
  const w = client('t41w');
  const res = await w('POST', '/api/rooms/watch', { code: room.code });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'This room has no live board');
});

test('T42 watch: unknown-code 404s count toward the shared by-code rate limiter', async () => {
  const xff = '203.0.113.42';
  const watchRaw = (body) => fetch(`${base}/api/rooms/watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: JSON.stringify(body),
  });
  for (let i = 0; i < 10; i++) {
    const res = await watchRaw({ code: '000002' });
    assert.equal(res.status, 404);
  }
  const blocked = await watchRaw({ code: '000002' });
  assert.equal(blocked.status, 429);
});

test('T43 a spectator upgrades to a player by joining with a name once a seat is free', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const w = client('t43w');

  const watched = await w('POST', '/api/rooms/watch', { code: room.code });
  assert.equal(watched.body.role, 'spectator');

  const upgraded = await w('POST', '/api/rooms/join', { code: room.code, name: 'Upgraded43' });
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.body.type, 'managed');
  assert.equal(upgraded.body.role, 'player');

  // Same visitor, rejoining: stays a player, same row (idempotent), not a duplicate.
  const again = await w('POST', '/api/rooms/join', { code: room.code, name: 'Upgraded43' });
  assert.equal(again.body.playerId, upgraded.body.playerId);
  assert.equal(again.body.role, 'player');
});

// ---------- Addendum B2: chat in managed rooms ----------

test('T44 chat send/receive: a player message reaches the host and other players with the full shape', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t44a');
  const b = client('t44b');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A44' });
  await b('POST', '/api/rooms/join', { code: room.code, name: 'B44' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  const sb = await connectSocket(b.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  await emitAck(sb, 'room:join', { code: room.code });

  const seenByHost = waitFor(host, 'chat:message', (m) => m.text === 'hello everyone');
  const seenByB = waitFor(sb, 'chat:message', (m) => m.text === 'hello everyone');
  const sendAck = await emitAck(sa, 'chat:send', { text: 'hello everyone' });
  assert.equal(sendAck.ok, true);
  const msgHost = await seenByHost;
  const msgB = await seenByB;
  assert.deepEqual(msgHost, msgB);
  assert.equal(msgHost.authorRole, 'player');
  assert.equal(msgHost.name, 'A44');
  assert.ok(msgHost.id);
  assert.ok(msgHost.createdAt);
  assert.equal(msgHost.text, 'hello everyone');

  // The host can send too, with authorRole 'host' and the owner's user name.
  const seenHostMsg = waitFor(sa, 'chat:message', (m) => m.authorRole === 'host');
  assert.equal((await emitAck(host, 'chat:send', { text: 'hi from the host' })).ok, true);
  const hostMsg = await seenHostMsg;
  assert.equal(hostMsg.name, 'Admin');
  assert.equal(hostMsg.playerId, null);
});

test('T45 a spectator cannot send chat, only react', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const w = client('t45w');
  await w('POST', '/api/rooms/watch', { code: room.code });
  const sw = await connectSocket(w.cookieHeader());
  await emitAck(sw, 'room:join', { code: room.code });

  const sendAck = await emitAck(sw, 'chat:send', { text: 'let me in' });
  assert.equal(sendAck.ok, false);
  assert.match(sendAck.error, /Watchers cannot send/);
});

test('T46 chat:send is rate-limited per socket: max 5/10s and >=700ms apart', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t46a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A46' });
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });

  // Two sends back-to-back: the second is inside the 700ms minimum gap.
  const first = await emitAck(sa, 'chat:send', { text: 'one' });
  assert.equal(first.ok, true);
  const second = await emitAck(sa, 'chat:send', { text: 'two' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'Slow down a little');
});

test('T47 chat:send rejects an empty message and one over 200 characters', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t47a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A47' });
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });

  const empty = await emitAck(sa, 'chat:send', { text: '   ' });
  assert.equal(empty.ok, false);

  const tooLong = await emitAck(sa, 'chat:send', { text: 'x'.repeat(201) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /200 characters/);

  const exactly200 = await emitAck(sa, 'chat:send', { text: 'y'.repeat(200) });
  assert.equal(exactly200.ok, true);
});

test('T48 chat off refuses both send and react; turning it back on re-pushes history to everyone', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t48a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A48' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });
  assert.equal((await emitAck(sa, 'chat:send', { text: 'before off' })).ok, true);

  const offState = waitFor(host, 'room:state', (v) => v.chatEnabled === false);
  assert.equal((await emitAck(host, 'host:action', { type: 'chatEnabled', enabled: false })).ok, true);
  await offState;

  const blockedSend = await emitAck(sa, 'chat:send', { text: 'nope' });
  assert.equal(blockedSend.ok, false);
  assert.equal(blockedSend.error, 'Chat is turned off');

  // Reactions are silently dropped (no ack), not errored — confirm no reaction event lands.
  let reactionSeen = false;
  sa.on('chat:reaction', () => { reactionSeen = true; });
  sa.emit('chat:react', { emoji: '🔥' });
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(reactionSeen, false);

  // Turning it back on re-pushes chat:history to every connected socket.
  const historyForA = waitFor(sa, 'chat:history', (h) => h.some((m) => m.text === 'before off'));
  assert.equal((await emitAck(host, 'host:action', { type: 'chatEnabled', enabled: true })).ok, true);
  const history = await historyForA;
  assert.ok(Array.isArray(history));
});

test('T49 host delete marks a message deleted and broadcasts chat:deleted', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t49a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A49' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });

  const sent = waitFor(host, 'chat:message');
  await emitAck(sa, 'chat:send', { text: 'delete me' });
  const message = await sent;

  const deletedSeen = waitFor(sa, 'chat:deleted', (d) => d.id === message.id);
  assert.equal((await emitAck(host, 'host:action', { type: 'chatDelete', messageId: message.id })).ok, true);
  await deletedSeen;

  // A deleted message is excluded from a fresh chat:history push (reconnect).
  const sa2 = await connectSocket(a.cookieHeader());
  const historyPromise = new Promise((resolve) => sa2.once('chat:history', resolve));
  await emitAck(sa2, 'room:join', { code: room.code });
  const history = await historyPromise;
  assert.ok(!history.some((m) => m.id === message.id));

  const again = await emitAck(host, 'host:action', { type: 'chatDelete', messageId: message.id });
  assert.equal(again.ok, false, 'deleting an already-deleted message is a 404, not a silent success');
});

test('T50 chat:history is pushed right after room:join when chat is on, and withheld for non-hosts when it is off', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t50a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A50' });
  const sa = await connectSocket(a.cookieHeader());
  const historyPromise = new Promise((resolve) => sa.once('chat:history', resolve));
  await emitAck(sa, 'room:join', { code: room.code });
  const history = await historyPromise;
  assert.deepEqual(history, []);

  const host = await connectSocket(admin.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  assert.equal((await emitAck(host, 'host:action', { type: 'chatEnabled', enabled: false })).ok, true);

  let gotHistory = false;
  const sa2 = await connectSocket(a.cookieHeader());
  sa2.on('chat:history', () => { gotHistory = true; });
  await emitAck(sa2, 'room:join', { code: room.code });
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(gotHistory, false, 'a non-host must not get chat:history when chat is off');

  // The host still gets one, so they can moderate/review while chat is off.
  let hostGotHistory = false;
  const host2 = await connectSocket(admin.cookieHeader());
  host2.on('chat:history', () => { hostGotHistory = true; });
  await emitAck(host2, 'room:join', { code: room.code, as: 'host' });
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(hostGotHistory, true);
});

test('T51 chatEnabled and chatDelete are owner-checked like every other host action', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });

  const bCreds = { email: 'iso-chat-b@example.com', name: 'Iso Chat B', password: 'longenough1' };
  assert.equal((await admin('POST', '/api/admin/users', bCreds)).status, 201);
  const b = await login(bCreds.email, bCreds.password);

  const bHost = await connectSocket(b.cookieHeader());
  assert.equal((await emitAck(bHost, 'room:join', { code: room.code, as: 'host' })).ok, false);

  // Same room, A's own socket, then session revoked — chatEnabled must re-check (not just trust
  // the role cached at room:join). Separate sockets for the two actions below: the handler
  // downgrades a socket's cached role to null the first time it catches a revoked session (see
  // host:action / T25), so reusing one socket for a second check would just re-prove the downgrade
  // (403 'Host only') instead of independently exercising each action's own re-check.
  const hostForEnabled = await connectSocket(admin.cookieHeader());
  assert.equal((await emitAck(hostForEnabled, 'room:join', { code: room.code, as: 'host' })).ok, true);
  await admin('POST', '/api/auth/logout');
  const afterLogoutEnabled = await emitAck(hostForEnabled, 'host:action', { type: 'chatEnabled', enabled: false });
  assert.equal(afterLogoutEnabled.ok, false);
  assert.equal(afterLogoutEnabled.error, 'Please sign in');

  const admin2 = await adminReq(); // fresh session for the room's owner
  const hostForDelete = await connectSocket(admin2.cookieHeader());
  assert.equal((await emitAck(hostForDelete, 'room:join', { code: room.code, as: 'host' })).ok, true);
  await admin2('POST', '/api/auth/logout');
  const afterLogoutDelete = await emitAck(hostForDelete, 'host:action', { type: 'chatDelete', messageId: 'whatever' });
  assert.equal(afterLogoutDelete.ok, false);
  assert.equal(afterLogoutDelete.error, 'Please sign in');
});

test('T52 chat:react only accepts the whitelisted emoji and throttles to 1 per 1.5s; not stored in history', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t52a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A52' });
  const host = await connectSocket(admin.cookieHeader());
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(host, 'room:join', { code: room.code, as: 'host' });
  await emitAck(sa, 'room:join', { code: room.code });

  const goodReaction = waitFor(host, 'chat:reaction', (r) => r.emoji === '🔥');
  sa.emit('chat:react', { emoji: '🔥' });
  const reaction = await goodReaction;
  assert.equal(reaction.name, 'A52');

  // Not whitelisted -> silently dropped, no event.
  let extraSeen = false;
  host.on('chat:reaction', (r) => { if (r.emoji === '💩') extraSeen = true; });
  sa.emit('chat:react', { emoji: '💩' });
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(extraSeen, false);

  // Throttled: a second whitelisted reaction inside 1.5s is also dropped.
  let secondSeen = false;
  host.on('chat:reaction', (r) => { if (r.emoji === '🎉') secondSeen = true; });
  sa.emit('chat:react', { emoji: '🎉' });
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(secondSeen, false);

  // Reactions never land in chat:history — nothing was ever sent as a chat message in this test.
  const sa2 = await connectSocket(a.cookieHeader());
  const historyPromise = new Promise((resolve) => sa2.once('chat:history', resolve));
  await emitAck(sa2, 'room:join', { code: room.code });
  const history = await historyPromise;
  assert.equal(history.length, 0);
});

test('T53 default rooms have no chat: chatEnabled is false and there is no live board to send to', async () => {
  const admin = await adminReq();
  const room = await createDefaultRoom(admin);
  assert.equal(room.chatEnabled, false);

  const attempt = await admin('PUT', `/api/admin/rooms/${room.id}`, { chatEnabled: true });
  assert.equal(attempt.status, 200);
  assert.equal(attempt.body.chatEnabled, false, 'chatEnabled must stay false/ignored for a default room');
});

test('T54 room_messages cascade-deletes cleanly when a room is removed (FK ON DELETE CASCADE, no crash)', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t54a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A54' });
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });
  assert.equal((await emitAck(sa, 'chat:send', { text: 'will be gone soon' })).ok, true);

  // Closing (soft-delete) a room does not touch room_messages at all — cascade only fires on a
  // real row delete. There is no hard-delete admin endpoint, so exercise the FK directly, exactly
  // as a future hard-delete/cleanup job would rely on it.
  await db.query('DELETE FROM rooms WHERE id = $1', [room.id]);
  const remaining = await db.query('SELECT COUNT(*)::int AS n FROM room_messages WHERE room_id = $1', [room.id]);
  assert.equal(remaining[0].n, 0);
});

test('T55 PUT /api/admin/rooms/:id {chatEnabled} on a managed room broadcasts room:state (not just a silent write)', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t55a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A55' });
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });

  const offState = waitFor(sa, 'room:state', (v) => v.chatEnabled === false);
  const put = await admin('PUT', `/api/admin/rooms/${room.id}`, { chatEnabled: false });
  assert.equal(put.status, 200);
  assert.equal(put.body.chatEnabled, false);
  await offState; // proves the connected player's socket actually received the update

  const onState = waitFor(sa, 'room:state', (v) => v.chatEnabled === true);
  const historyPush = new Promise((resolve) => sa.once('chat:history', resolve));
  const put2 = await admin('PUT', `/api/admin/rooms/${room.id}`, { chatEnabled: true });
  assert.equal(put2.body.chatEnabled, true);
  await onState;
  await historyPush; // turning ON re-pushes chat:history too, same as the socket path (T48)
});

test('T56 chat:send is atomically rate-limited: N sends fired in the same tick (no awaited acks in between) yield exactly one success', async () => {
  const admin = await adminReq();
  const room = await createRoom(admin, { boxCount: 2 });
  const a = client('t56a');
  await a('POST', '/api/rooms/join', { code: room.code, name: 'A56' });
  const sa = await connectSocket(a.cookieHeader());
  await emitAck(sa, 'room:join', { code: room.code });

  const acks = await Promise.all([
    emitAck(sa, 'chat:send', { text: 'race 1' }),
    emitAck(sa, 'chat:send', { text: 'race 2' }),
    emitAck(sa, 'chat:send', { text: 'race 3' }),
  ]);
  assert.equal(acks.filter((r) => r.ok).length, 1, 'exactly one of N concurrently-fired sends may pass the 700ms-apart rate limit');
  assert.equal(acks.filter((r) => !r.ok && r.error === 'Slow down a little').length, 2);
});
