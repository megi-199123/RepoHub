'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/app');
const { openDatabase } = require('../server/db');
const { Store } = require('../server/store');
const { fillBoxes } = require('../server/draw');

const ADMIN_PASSWORD = 'hunter2';

let server;
let base;
let db;
let closeApp;

// Runs against an in-memory embedded Postgres by default.
// Set TEST_DATABASE_URL to run them against a real (throwaway!) Postgres database.
before(async () => {
  db = await openDatabase({ databaseUrl: process.env.TEST_DATABASE_URL, memory: true });
  if (process.env.TEST_DATABASE_URL) {
    await db.query(
      'DROP TABLE IF EXISTS room_messages, room_boxes, room_players, rooms, settings, prizes, draws, rounds, admin_sessions, images, user_sessions, users',
    );
  }
  const { app, ready, attach, close } = createApp({ db, adminPassword: ADMIN_PASSWORD });
  closeApp = close;
  await ready;
  server = http.createServer(app);
  attach(server);
  await new Promise((resolve) => { server.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeApp();
  // Tolerant of ERR_SERVER_NOT_RUNNING: closeApp()/io.close() above already closed this server.
  await new Promise((resolve) => server.close(() => resolve()));
  await db.close();
});

/** Minimal cookie-keeping client, so each "browser" has its own visitor id / session. */
function client() {
  const jar = {};
  return async function request(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v) jar[k] = v;
      else delete jar[k];
    }
    const text = await res.text();
    return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
}

async function login(email, password) {
  const req = client();
  const res = await req('POST', '/api/auth/login', { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return req;
}

const superadmin = () => login('admin', ADMIN_PASSWORD);

async function createRoom(admin, opts = {}) {
  const res = await admin('POST', '/api/admin/rooms', opts);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const createDefaultRoom = (admin, opts = {}) => createRoom(admin, { type: 'default', ...opts });

test('login requires a valid email/password; wrong password is rejected', async () => {
  const req = client();
  assert.equal((await req('POST', '/api/auth/login', { email: 'admin', password: 'nope' })).status, 401);
  assert.equal((await req('GET', '/api/auth/me')).body.authenticated, false);
  const ok = await req('POST', '/api/auth/login', { email: 'admin', password: ADMIN_PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'superadmin');
  assert.equal((await req('GET', '/api/auth/me')).body.user.email, 'admin');
});

test('login is rate-limited: 10 wrong passwords from one IP then a 429', async () => {
  const xff = '198.51.100.9';
  const attempt = () => fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: JSON.stringify({ email: 'admin', password: 'wrong-password' }),
  });
  for (let i = 0; i < 10; i++) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
});

test('admin endpoints require a session', async () => {
  const req = client();
  assert.equal((await req('GET', '/api/admin/rooms')).status, 401);
});

test('a default room: config, deal, pick, reveal', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);

  const player = client();
  const config = await player('GET', `/api/rooms/${room.code}/config`);
  assert.equal(config.status, 200);
  assert.equal(config.body.boxCount, 4);
  assert.equal(config.body.prizes.length, 4);
  assert.equal(config.body.prizes[0].weight, undefined);
  assert.equal(config.body.prizes[0].stock, undefined);

  const round = await player('POST', `/api/rooms/${room.code}/rounds`);
  assert.equal(round.status, 201);
  assert.equal(round.body.boxCount, 4);

  const pick = await player('POST', `/api/rooms/${room.code}/rounds/${round.body.roundId}/pick`, { box: 2 });
  assert.equal(pick.status, 200);
  assert.equal(pick.body.box, 2);
  assert.deepEqual(pick.body.boxes[2], pick.body.prize);
  assert.equal(new Set(pick.body.boxes.map((p) => p.id)).size, 4);
  if (pick.body.prize.winning) assert.match(pick.body.code, /^MB-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  else assert.equal(pick.body.code, null);

  // A round can only be opened once.
  const again = await player('POST', `/api/rooms/${room.code}/rounds/${round.body.roundId}/pick`, { box: 1 });
  assert.equal(again.status, 404);
});

test('rounds belong to the visitor who dealt them', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);
  const alice = client();
  const bob = client();
  await alice('GET', `/api/rooms/${room.code}/config`);
  await bob('GET', `/api/rooms/${room.code}/config`);
  const round = await alice('POST', `/api/rooms/${room.code}/rounds`);
  const res = await bob('POST', `/api/rooms/${room.code}/rounds/${round.body.roundId}/pick`, { box: 0 });
  assert.equal(res.status, 404);
});

test('rejects out-of-range box', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);
  const player = client();
  const round = await player('POST', `/api/rooms/${room.code}/rounds`);
  const res = await player('POST', `/api/rooms/${room.code}/rounds/${round.body.roundId}/pick`, { box: 9 });
  assert.equal(res.status, 400);
});

test('lookup: unknown code is 404, an ended room is 409, a live room reports its type', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);
  const req = client();
  assert.equal((await req('POST', '/api/rooms/lookup', { code: '999999' })).status, 404);
  const ok = await req('POST', '/api/rooms/lookup', { code: room.code });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.type, 'default');
  assert.equal(ok.body.title, 'Mystery Box');

  await admin('DELETE', `/api/admin/rooms/${room.id}`);
  assert.equal((await req('POST', '/api/rooms/lookup', { code: room.code })).status, 409);
});

test('config on a managed room is refused with a friendly message', async () => {
  const admin = await superadmin();
  const room = await createRoom(admin, { type: 'managed', boxCount: 3 });
  const res = await client()('GET', `/api/rooms/${room.code}/config`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /hosted live/);
});

test('admin can manage prizes and stock is decremented on win', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);
  const prizes = (await admin('GET', `/api/admin/rooms/${room.id}/prizes`)).body;

  // Deactivate everything, then add a single limited prize.
  for (const p of prizes) await admin('PUT', `/api/admin/rooms/${room.id}/prizes/${p.id}`, { active: false });
  const created = await admin('POST', `/api/admin/rooms/${room.id}/prizes`, { name: 'Teddy', emoji: '🧸', color: '#ec4899', weight: 5, stock: 2 });
  assert.equal(created.status, 201);

  const bad = await admin('POST', `/api/admin/rooms/${room.id}/prizes`, { name: '', weight: 1 });
  assert.equal(bad.status, 400);
  const badColor = await admin('POST', `/api/admin/rooms/${room.id}/prizes`, { name: 'X', color: 'red' });
  assert.equal(badColor.status, 400);

  const player = client();
  for (let i = 0; i < 2; i++) {
    const round = await player('POST', `/api/rooms/${room.code}/rounds`);
    const pick = await player('POST', `/api/rooms/${room.code}/rounds/${round.body.roundId}/pick`, { box: 0 });
    assert.equal(pick.body.prize.name, 'Teddy');
  }
  const teddy = (await admin('GET', `/api/admin/rooms/${room.id}/prizes`)).body.find((p) => p.id === created.body.id);
  assert.equal(teddy.stock, 0);
  assert.equal(teddy.won, 2);

  // Out of stock and nothing else active: the game says so.
  const round = await player('POST', `/api/rooms/${room.code}/rounds`);
  assert.equal(round.status, 409);
});

test('B1 prize imageBorder: defaults true, validated like winning/active, carried through create/update/copy/public views', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);

  // Default (no imageBorder in the request) is true.
  const plain = await admin('POST', `/api/admin/rooms/${room.id}/prizes`, { name: 'Plain', color: '#8b5cf6', weight: 1 });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.imageBorder, true);

  // Explicit false is honored; only `!== false` counts as true, same rule as winning/active.
  const borderless = await admin('POST', `/api/admin/rooms/${room.id}/prizes`, {
    name: 'Borderless', color: '#8b5cf6', weight: 1, image: '/uploads/logo.png', imageBorder: false,
  });
  assert.equal(borderless.status, 201);
  assert.equal(borderless.body.imageBorder, false);

  // Round-trips through GET (admin list).
  const listed = (await admin('GET', `/api/admin/rooms/${room.id}/prizes`)).body.find((p) => p.id === borderless.body.id);
  assert.equal(listed.imageBorder, false);

  // publicPrize (the shape players see) includes it too — verified via a default room's config,
  // while the prize is still borderless (before the PUT below flips it back).
  const player = client();
  const configBefore = await player('GET', `/api/rooms/${room.code}/config`);
  const publicBorderless = configBefore.body.prizes.find((p) => p.id === borderless.body.id);
  assert.equal(publicBorderless.imageBorder, false);
  assert.equal(publicBorderless.weight, undefined, 'publicPrize must still omit weight/stock');

  // PUT (update) round-trips it too.
  const updated = await admin('PUT', `/api/admin/rooms/${room.id}/prizes/${borderless.body.id}`, { imageBorder: true });
  assert.equal(updated.body.imageBorder, true);

  // copyPrizesFrom carries the (now true) value over.
  const copyRoom = await createDefaultRoom(admin, { copyPrizesFrom: room.id });
  const copiedBorderless = (await admin('GET', `/api/admin/rooms/${copyRoom.id}/prizes`)).body.find((p) => p.name === 'Borderless');
  assert.equal(copiedBorderless.imageBorder, true, 'copy happened after the PUT above set it back to true');
});

test('plays per visitor is enforced per room', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin, { maxPlaysPerVisitor: 1 });

  const player = client();
  assert.equal((await player('GET', `/api/rooms/${room.code}/config`)).body.playsLeft, 1);
  const round = await player('POST', `/api/rooms/${room.code}/rounds`);
  const pick = await player('POST', `/api/rooms/${room.code}/rounds/${round.body.roundId}/pick`, { box: 0 });
  assert.equal(pick.body.playsLeft, 0);
  assert.equal((await player('POST', `/api/rooms/${room.code}/rounds`)).status, 403);
});

test('room settings validation and box count', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);
  assert.equal((await admin('PUT', `/api/admin/rooms/${room.id}`, { boxCount: 1 })).status, 400);
  assert.equal((await admin('PUT', `/api/admin/rooms/${room.id}`, { assignment: 'magic' })).status, 400);
  const ok = await admin('PUT', `/api/admin/rooms/${room.id}`, { boxCount: 6, title: 'Lucky Boxes' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.boxCount, 6);

  const player = client();
  const round = await player('POST', `/api/rooms/${room.code}/rounds`);
  assert.equal(round.body.boxCount, 6);
});

test('a managed room in the lobby still allows boxCount changes (the past-lobby 409 is covered in rooms.test.js, which can actually start the game)', async () => {
  const admin = await superadmin();
  const room = await createRoom(admin, { type: 'managed', boxCount: 2 });
  const player = client();
  await player('POST', '/api/rooms/join', { code: room.code, name: 'Al' });
  assert.equal((await admin('PUT', `/api/admin/rooms/${room.id}`, { boxCount: 3 })).status, 200);
});

test('winners log: redeem and CSV export', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);
  const player = client();
  const round = await player('POST', `/api/rooms/${room.code}/rounds`);
  await player('POST', `/api/rooms/${room.code}/rounds/${round.body.roundId}/pick`, { box: 0 });

  const draws = (await admin('GET', `/api/admin/draws?roomId=${room.id}`)).body;
  assert.ok(draws.length > 0);
  const win = draws.find((d) => d.code);
  if (win) {
    const res = await admin('PATCH', `/api/admin/draws/${win.id}`, { redeemed: true });
    assert.equal(res.body.redeemed, true);
  }
  const csv = await admin('GET', '/api/admin/draws.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.body, /^"Date","Claim code","Prize"/);

  // Closing the room must not hide its draws: list, redeem toggle and CSV all keep working.
  assert.equal((await admin('DELETE', `/api/admin/rooms/${room.id}`)).status, 204);
  const afterClose = await admin('GET', `/api/admin/draws?roomId=${room.id}`);
  assert.equal(afterClose.status, 200);
  assert.ok(afterClose.body.length > 0, 'a closed room\'s draws must still be listed');
  if (win) {
    assert.equal((await admin('PATCH', `/api/admin/draws/${win.id}`, { redeemed: false })).status, 200);
  }
  const csvAfterClose = await admin('GET', `/api/admin/draws.csv?roomId=${room.id}`);
  assert.equal(csvAfterClose.status, 200);
  assert.ok(csvAfterClose.body.includes(room.code));
});

test('uploads accept images only', async () => {
  const admin = await superadmin();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const ok = await admin('POST', '/api/admin/uploads', { dataUrl: png });
  assert.equal(ok.status, 201);
  assert.match(ok.body.url, /^\/uploads\/[\w-]+\.png$/);
  assert.equal((await fetch(base + ok.body.url)).status, 200);

  const bad = await admin('POST', '/api/admin/uploads', { dataUrl: 'data:text/html;base64,PGgxPg==' });
  assert.equal(bad.status, 400);
});

test('migrations are idempotent: the superadmin is seeded only once', async () => {
  const store = new Store(db);
  await store.migrate({ adminPassword: ADMIN_PASSWORD });
  await store.migrate({ adminPassword: ADMIN_PASSWORD });
  const users = await store.listUsers();
  assert.equal(users.filter((u) => u.role === 'superadmin').length, 1);
});

test('a round can be opened only once, even concurrently', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);
  const player = client();
  const round = await player('POST', `/api/rooms/${room.code}/rounds`);
  const results = await Promise.all(
    [0, 1, 2].map((box) => player('POST', `/api/rooms/${room.code}/rounds/${round.body.roundId}/pick`, { box })),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 404, 404]);
});

test('the last item in stock cannot be won twice under concurrent picks', async () => {
  const admin = await superadmin();
  const room = await createDefaultRoom(admin);
  const prizes = (await admin('GET', `/api/admin/rooms/${room.id}/prizes`)).body;
  for (const p of prizes) await admin('PUT', `/api/admin/rooms/${room.id}/prizes/${p.id}`, { active: false });
  const last = (await admin('POST', `/api/admin/rooms/${room.id}/prizes`, { name: 'Last One', weight: 1, stock: 1 })).body;

  const players = Array.from({ length: 20 }, () => client());
  const rounds = await Promise.all(players.map((p) => p('POST', `/api/rooms/${room.code}/rounds`)));
  const picks = await Promise.all(players.map((p, i) => p('POST', `/api/rooms/${room.code}/rounds/${rounds[i].body.roundId}/pick`, { box: 0 })));

  assert.equal(picks.filter((r) => r.status === 200).length, 1);
  assert.ok(picks.every((r) => r.status === 200 || r.status === 409));
  const after = (await admin('GET', `/api/admin/rooms/${room.id}/prizes`)).body.find((p) => p.id === last.id);
  assert.equal(after.stock, 0);
  assert.equal(after.won, 1);
});

// ---------- users (superadmin only) ----------

test('users: invite, duplicate email rejected, weak password rejected', async () => {
  const admin = await superadmin();
  const created = await admin('POST', '/api/admin/users', { email: 'tenantb@example.com', name: 'Tenant B', password: 'longenough1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'user');
  assert.equal(created.body.roomCount, 0);

  const dup = await admin('POST', '/api/admin/users', { email: 'TenantB@example.com', name: 'Dup', password: 'longenough1' });
  assert.equal(dup.status, 409);

  const weak = await admin('POST', '/api/admin/users', { email: 'weak@example.com', name: 'Weak', password: 'short' });
  assert.equal(weak.status, 400);

  const list = await admin('GET', '/api/admin/users');
  assert.equal(list.status, 200);
  assert.ok(list.body.some((u) => u.email === 'tenantb@example.com'));
});

test('users: cannot disable or demote self; a non-superadmin gets 403', async () => {
  const admin = await superadmin();
  const me = (await admin('GET', '/api/auth/me')).body.user;

  assert.equal((await admin('PATCH', `/api/admin/users/${me.id}`, { disabled: true })).status, 400);
  assert.equal((await admin('PATCH', `/api/admin/users/${me.id}`, { role: 'user' })).status, 400);

  await admin('POST', '/api/admin/users', { email: 'plain@example.com', name: 'Plain', password: 'longenough1' });
  const plain = await login('plain@example.com', 'longenough1');
  assert.equal((await plain('GET', '/api/admin/users')).status, 403);
  assert.equal((await plain('POST', '/api/admin/users', { email: 'x@x.com', name: 'X', password: 'longenough1' })).status, 403);
});

test('users: disabling a user ends their session and blocks future logins', async () => {
  const admin = await superadmin();
  const created = (await admin('POST', '/api/admin/users', { email: 'disableme@example.com', name: 'Bye', password: 'longenough1' })).body;
  const session = await login('disableme@example.com', 'longenough1');
  assert.equal((await session('GET', '/api/admin/rooms')).status, 200);

  const disable = await admin('PATCH', `/api/admin/users/${created.id}`, { disabled: true });
  assert.equal(disable.status, 200);
  assert.equal(disable.body.disabled, true);

  // The already-open session is invalid immediately.
  assert.equal((await session('GET', '/api/admin/rooms')).status, 401);
  // A fresh login attempt fails too.
  const relogin = await client()('POST', '/api/auth/login', { email: 'disableme@example.com', password: 'longenough1' });
  assert.equal(relogin.status, 401);
});

// ---------- tenant isolation ----------

test('tenant isolation: user B gets 404 on user A\'s room, prizes, odds and draws', async () => {
  const admin = await superadmin();
  const bCreds = { email: 'iso-b@example.com', name: 'Iso B', password: 'longenough1' };
  await admin('POST', '/api/admin/users', bCreds);
  const a = admin; // superadmin also owns rooms as a tenant
  const b = await login(bCreds.email, bCreds.password);

  const roomA = await createDefaultRoom(a);
  const player = client();
  const round = await player('POST', `/api/rooms/${roomA.code}/rounds`);
  await player('POST', `/api/rooms/${roomA.code}/rounds/${round.body.roundId}/pick`, { box: 0 });
  const prizeA = (await a('GET', `/api/admin/rooms/${roomA.id}/prizes`)).body[0];
  const drawA = (await a('GET', `/api/admin/draws?roomId=${roomA.id}`)).body[0];

  assert.equal((await b('GET', `/api/admin/rooms/${roomA.id}`)).status, 404);
  assert.equal((await b('PUT', `/api/admin/rooms/${roomA.id}`, { title: 'Hijacked' })).status, 404);
  assert.equal((await b('DELETE', `/api/admin/rooms/${roomA.id}`)).status, 404);
  assert.equal((await b('GET', `/api/admin/rooms/${roomA.id}/prizes`)).status, 404);
  assert.equal((await b('POST', `/api/admin/rooms/${roomA.id}/prizes`, { name: 'Hijack' })).status, 404);
  assert.equal((await b('PUT', `/api/admin/rooms/${roomA.id}/prizes/${prizeA.id}`, { name: 'Hijack' })).status, 404);
  assert.equal((await b('DELETE', `/api/admin/rooms/${roomA.id}/prizes/${prizeA.id}`)).status, 404);
  assert.equal((await b('GET', `/api/admin/rooms/${roomA.id}/odds`)).status, 404);

  // B's own (empty) draws list/CSV must never include A's draw, and B cannot redeem/clear it.
  assert.ok(drawA);
  const bDraws = await b('GET', '/api/admin/draws');
  assert.equal(bDraws.status, 200);
  assert.ok(!bDraws.body.some((d) => d.id === drawA.id));
  assert.equal((await b('PATCH', `/api/admin/draws/${drawA.id}`, { redeemed: true })).status, 404);
  await b('DELETE', '/api/admin/draws'); // clears only B's (zero) draws
  assert.ok((await a('GET', `/api/admin/draws?roomId=${roomA.id}`)).body.some((d) => d.id === drawA.id), "A's draw must survive B's clear");
});

test('tenant isolation: copyPrizesFrom must be my own room', async () => {
  const admin = await superadmin();
  const bCreds = { email: 'iso-copy-b@example.com', name: 'Iso Copy B', password: 'longenough1' };
  await admin('POST', '/api/admin/users', bCreds);
  const b = await login(bCreds.email, bCreds.password);

  const roomA = await createDefaultRoom(admin);
  const attempt = await b('POST', '/api/admin/rooms', { type: 'default', copyPrizesFrom: roomA.id });
  assert.equal(attempt.status, 404);
});

test('fillBoxes: unique mode never repeats while prizes last; weighted respects weights', () => {
  const prizes = ['a', 'b', 'c'].map((id, i) => ({ id, active: true, weight: [1, 1, 98][i], stock: null }));
  for (let i = 0; i < 200; i++) {
    const boxes = fillBoxes(prizes, 3, 'unique');
    assert.equal(new Set(boxes).size, 3);
  }
  let c = 0;
  for (let i = 0; i < 2000; i++) c += fillBoxes(prizes, 1, 'weighted')[0] === 'c';
  assert.ok(c > 1850, `expected ~98% c, got ${c / 20}%`);
  assert.equal(fillBoxes([{ id: 'x', active: true, weight: 1, stock: 0 }], 4, 'unique'), null);
});
