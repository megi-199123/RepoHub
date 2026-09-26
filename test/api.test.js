'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/app');
const { fillBoxes } = require('../server/draw');

let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mystery-box-'));
  const { app } = createApp({ dataDir, adminPassword: 'hunter2' });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Minimal cookie-keeping client, so each "browser" has its own visitor id. */
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

async function adminClient() {
  const req = client();
  const res = await req('POST', '/api/admin/login', { password: 'hunter2' });
  assert.equal(res.status, 200);
  return req;
}

test('public config exposes prizes without weights or stock', async () => {
  const req = client();
  const { status, body } = await req('GET', '/api/config');
  assert.equal(status, 200);
  assert.equal(body.boxCount, 4);
  assert.equal(body.prizes.length, 4);
  assert.equal(body.prizes[0].weight, undefined);
  assert.equal(body.prizes[0].stock, undefined);
});

test('a full round: deal, pick, reveal', async () => {
  const req = client();
  const round = await req('POST', '/api/rounds');
  assert.equal(round.status, 201);
  assert.equal(round.body.boxCount, 4);

  const pick = await req('POST', `/api/rounds/${round.body.roundId}/pick`, { box: 2 });
  assert.equal(pick.status, 200);
  assert.equal(pick.body.box, 2);
  assert.equal(pick.body.boxes.length, 4);
  assert.deepEqual(pick.body.boxes[2], pick.body.prize);
  // 4 prizes, 4 boxes, unique mode: every prize appears exactly once.
  assert.equal(new Set(pick.body.boxes.map((p) => p.id)).size, 4);
  if (pick.body.prize.winning) assert.match(pick.body.code, /^MB-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  else assert.equal(pick.body.code, null);

  // A round can only be opened once.
  const again = await req('POST', `/api/rounds/${round.body.roundId}/pick`, { box: 1 });
  assert.equal(again.status, 404);
});

test('rounds belong to the visitor who dealt them', async () => {
  const alice = client();
  const bob = client();
  await alice('GET', '/api/config');
  await bob('GET', '/api/config');
  const round = await alice('POST', '/api/rounds');
  const res = await bob('POST', `/api/rounds/${round.body.roundId}/pick`, { box: 0 });
  assert.equal(res.status, 404);
});

test('rejects out-of-range box', async () => {
  const req = client();
  const round = await req('POST', '/api/rounds');
  const res = await req('POST', `/api/rounds/${round.body.roundId}/pick`, { box: 9 });
  assert.equal(res.status, 400);
});

test('admin endpoints require login', async () => {
  const req = client();
  assert.equal((await req('GET', '/api/admin/prizes')).status, 401);
  assert.equal((await req('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  assert.equal((await req('GET', '/api/admin/me')).body.authenticated, false);
});

test('admin can manage prizes and stock is decremented on win', async () => {
  const admin = await adminClient();
  const prizes = (await admin('GET', '/api/admin/prizes')).body;

  // Deactivate everything, then add a single limited prize.
  for (const p of prizes) await admin('PUT', `/api/admin/prizes/${p.id}`, { active: false });
  const created = await admin('POST', '/api/admin/prizes', { name: 'Teddy', emoji: '🧸', color: '#ec4899', weight: 5, stock: 2 });
  assert.equal(created.status, 201);

  const bad = await admin('POST', '/api/admin/prizes', { name: '', weight: 1 });
  assert.equal(bad.status, 400);
  const badColor = await admin('POST', '/api/admin/prizes', { name: 'X', color: 'red' });
  assert.equal(badColor.status, 400);

  const player = client();
  for (let i = 0; i < 2; i++) {
    const round = await player('POST', '/api/rounds');
    const pick = await player('POST', `/api/rounds/${round.body.roundId}/pick`, { box: 0 });
    assert.equal(pick.body.prize.name, 'Teddy');
  }
  const teddy = (await admin('GET', '/api/admin/prizes')).body.find((p) => p.id === created.body.id);
  assert.equal(teddy.stock, 0);
  assert.equal(teddy.won, 2);

  // Out of stock and nothing else active: the game says so.
  const round = await player('POST', '/api/rounds');
  assert.equal(round.status, 409);

  // Restore for other tests.
  for (const p of prizes) await admin('PUT', `/api/admin/prizes/${p.id}`, { active: true });
  assert.equal((await admin('DELETE', `/api/admin/prizes/${created.body.id}`)).status, 204);
});

test('plays per visitor is enforced', async () => {
  const admin = await adminClient();
  await admin('PUT', '/api/admin/settings', { maxPlaysPerVisitor: 1 });

  const player = client();
  assert.equal((await player('GET', '/api/config')).body.playsLeft, 1);
  const round = await player('POST', '/api/rounds');
  const pick = await player('POST', `/api/rounds/${round.body.roundId}/pick`, { box: 0 });
  assert.equal(pick.body.playsLeft, 0);
  assert.equal((await player('POST', '/api/rounds')).status, 403);

  await admin('PUT', '/api/admin/settings', { maxPlaysPerVisitor: 0 });
});

test('settings validation and box count', async () => {
  const admin = await adminClient();
  assert.equal((await admin('PUT', '/api/admin/settings', { boxCount: 1 })).status, 400);
  assert.equal((await admin('PUT', '/api/admin/settings', { assignment: 'magic' })).status, 400);
  const ok = await admin('PUT', '/api/admin/settings', { boxCount: 6, title: 'Lucky Boxes' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.boxCount, 6);

  const player = client();
  const round = await player('POST', '/api/rounds');
  assert.equal(round.body.boxCount, 6);
  await admin('PUT', '/api/admin/settings', { boxCount: 4, title: 'Mystery Box' });
});

test('winners log: redeem and CSV export', async () => {
  const admin = await adminClient();
  const draws = (await admin('GET', '/api/admin/draws')).body;
  assert.ok(draws.length > 0);
  const win = draws.find((d) => d.code);
  if (win) {
    const res = await admin('PATCH', `/api/admin/draws/${win.id}`, { redeemed: true });
    assert.equal(res.body.redeemed, true);
  }
  const csv = await admin('GET', '/api/admin/draws.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.body, /^"Date","Claim code","Prize"/);
});

test('uploads accept images only', async () => {
  const admin = await adminClient();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const ok = await admin('POST', '/api/admin/uploads', { dataUrl: png });
  assert.equal(ok.status, 201);
  assert.match(ok.body.url, /^\/uploads\/[\w-]+\.png$/);
  assert.equal((await fetch(base + ok.body.url)).status, 200);

  const bad = await admin('POST', '/api/admin/uploads', { dataUrl: 'data:text/html;base64,PGgxPg==' });
  assert.equal(bad.status, 400);
});

test('data persists across restarts', () => {
  const { store } = createApp({ dataDir, adminPassword: 'x' });
  assert.ok(store.draws.length > 0);
  assert.equal(store.prizes.length, 4);
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
