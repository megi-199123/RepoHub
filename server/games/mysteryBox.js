'use strict';

const { HttpError } = require('../httpError');
const { int } = require('../validate');
const { fillBoxes, isAvailable, weightedPick } = require('../draw');
const { claimCode } = require('../codes');
const { publicPrize } = require('../prizeView');

const REVEAL_MODES = ['all', 'next'];

/** Deal boxes and move the room from lobby to picking. Room stays in the lobby on failure. */
async function start({ store }, room) {
  const prizes = await store.listPrizes(room.id);
  const boxes = fillBoxes(prizes, room.boxCount, room.settings.assignment);
  if (!boxes) throw new HttpError(409, 'All prizes have been claimed. Check back soon!');
  const updated = await store.beginPicking(room.id, boxes);
  if (!updated) throw new HttpError(409, 'This room has already started');
}

/**
 * A player claims a box. Requires picking. Re-locking the same box is a no-op success.
 *
 * `room` was read before this call started, so it cannot be trusted for the status check: on
 * real Postgres, this lock's write and reveal's prepare step (beginReveal) can each be mid-flight
 * at once, and without re-locking the same row here, this transaction could still commit its
 * locked_box *after* reveal already took its players snapshot — leaving a lock reveal never saw,
 * with no prize/draw ever recorded for that box. `lockRoom`'s `SELECT ... FOR UPDATE` and
 * `beginReveal`'s `UPDATE ... WHERE status IN (...)` both take a row lock on the same room id, so
 * Postgres serializes them: whichever starts first, the other blocks until it commits, and then
 * sees the now-final status. Re-checking `fresh.status` (not the stale `room.status`) after that
 * lock is what makes the check race-free.
 */
async function lock({ store, room }, playerId, box) {
  const b = int(box, 'box', 0, room.boxCount - 1);
  await store.db.tx(async (q) => {
    const fresh = await store.lockRoom(q, room.id);
    if (!fresh || fresh.status !== 'picking') throw new HttpError(409, 'Boxes are not open for picking right now');

    const players = await store.listPlayers(room.id, q);
    const player = players.find((p) => p.id === playerId);
    if (!player || player.kicked) throw new HttpError(403, 'You are not in this room');
    if (player.role !== 'player') throw new HttpError(403, 'Spectators cannot pick a box');

    // Clearing our own lock first makes re-locking the same box idempotent. If setLock then
    // reports 'taken' we throw, rolling back the clear too, so the player keeps their old lock.
    await store.clearLock(q, room.id, playerId);
    const result = await store.setLock(q, room.id, playerId, b);
    if (result === 'taken') throw new HttpError(409, 'That box is already taken');
    if (!result) throw new HttpError(403, 'You are not in this room');
  });
}

/** A player releases their box. Requires picking. Same re-lock/re-check ordering as `lock` above. */
async function unlock({ store, room }, playerId) {
  await store.db.tx(async (q) => {
    const fresh = await store.lockRoom(q, room.id);
    if (!fresh || fresh.status !== 'picking') throw new HttpError(409, 'Boxes are not open for picking right now');

    const players = await store.listPlayers(room.id, q);
    const player = players.find((p) => p.id === playerId);
    if (!player || player.kicked) throw new HttpError(403, 'You are not in this room');
    if (player.role !== 'player') throw new HttpError(403, 'Spectators have nothing to release');

    await store.clearLock(q, room.id, playerId);
  });
}

/** The host starts (or restarts) a countdown to close picking. Requires picking. Returns the new countdown_ends_at. */
async function countdown({ store, room }, seconds) {
  const s = int(seconds, 'seconds', 5, 120);
  if (room.status !== 'picking') throw new HttpError(409, 'Boxes are not open for picking right now');
  const endsAt = new Date(Date.now() + s * 1000);
  const updated = await store.armCountdown(room.id, endsAt);
  if (!updated) throw new HttpError(409, 'Boxes are not open for picking right now');
  return updated.countdownEndsAt;
}

/** Countdown timer fired. picking -> locked. A no-op (stale timer) if the room already moved on. */
async function onCountdownEnd({ store }, room) {
  return store.lockAfterCountdown(room.id);
}

/**
 * Reveal boxes. The first call (from picking or locked) prepares the whole room atomically:
 * every locked player's stock is taken (with the out-of-stock swap used by the solo route) and
 * recorded as a draw, and a room_boxes row is created for every box in the room — locked boxes
 * get their final prize/player/draw, unlocked boxes get only the dealt prize id, no stock taken.
 * Later calls (and the case of zero locks, handled inline below) just advance which boxes are
 * shown, ending in `finished` once nothing is left to reveal.
 */
async function reveal({ store, room }, mode) {
  if (!REVEAL_MODES.includes(mode)) throw new HttpError(400, 'mode must be "all" or "next"');
  if (room.status === 'finished' || room.status === 'closed') {
    throw new HttpError(409, 'The reveal is already complete');
  }
  if (!['picking', 'locked', 'revealing'].includes(room.status)) {
    throw new HttpError(409, 'This room has nothing to reveal');
  }

  await store.db.tx(async (q) => {
    // `beginReveal`'s UPDATE takes the same row lock `lockRoom` above uses, and holds it for the
    // rest of this transaction — so a concurrent lock()/unlock() call either lands its own
    // `lockRoom` first (and this UPDATE then waits and sees the committed lock in `listPlayers`
    // below) or lands after this transaction commits (and its `fresh.status` check then correctly
    // sees 'revealing', not 'picking'). Either order is race-free; see the comment on `lock` above.
    const began = await store.beginReveal(q, room.id);
    if (!began) return; // already prepared by an earlier reveal call

    const players = await store.listPlayers(room.id, q);
    const lockedPlayers = players
      .filter((p) => !p.kicked && p.lockedBox !== null && p.lockedBox !== undefined)
      .sort((a, b) => a.lockedBox - b.lockedBox);

    const rowsByBox = new Map();
    for (const player of lockedPlayers) {
      const box = player.lockedBox;
      const dealtId = began.boxes[box];
      let prize = await store.takePrize(q, room.id, dealtId);
      for (let attempt = 0; !prize && attempt < 5; attempt++) {
        const pool = (await store.listPrizes(room.id, q)).filter(isAvailable);
        if (pool.length === 0) break;
        prize = await store.takePrize(q, room.id, weightedPick(pool).id);
      }
      // If literally nothing was available (every prize exhausted mid-reveal), record no prize at
      // all rather than crediting the player with the dealt id they never actually received —
      // unlike the solo route, a room reveal can't throw here without blocking every other player.
      const finalPrizeId = prize ? prize.id : null;
      const draw = await store.insertDraw(q, {
        code: prize && prize.winning ? claimCode() : null,
        prizeId: finalPrizeId,
        prizeName: prize ? prize.name : 'Out of stock',
        emoji: prize ? prize.emoji : '',
        visitor: player.visitor,
        roomId: room.id,
        playerName: player.name,
      });
      rowsByBox.set(box, { box, prizeId: finalPrizeId, playerId: player.id, drawId: draw.id });
    }

    const allRows = [];
    for (let i = 0; i < began.boxCount; i++) {
      allRows.push(rowsByBox.get(i) || { box: i, prizeId: began.boxes[i], playerId: null, drawId: null });
    }
    await store.insertRoomBoxes(q, room.id, allRows);

    if (lockedPlayers.length === 0) {
      // Nobody locked a box: open everything now, no draws recorded.
      for (const r of allRows) await store.markBoxRevealed(q, room.id, r.box);
      await store.finishReveal(q, room.id);
    }
  });

  // Re-read after the tx: a concurrently *closed* room must never be resurrected to 'finished' by
  // the reveal steps below, so proceed only while the room is still actually 'revealing' — not
  // just "not finished" (that would also let a closed room through). `finishReveal` re-checks this
  // same condition atomically at write time, so a close that lands after this read (but before the
  // write below) still can't be undone.
  const current = await store.getRoom(room.id);
  if (!current || current.status !== 'revealing') return;

  const boxes = await store.listRoomBoxes(room.id);
  const lockedUnrevealed = boxes.filter((b) => b.playerId && !b.revealedAt).sort((a, b) => a.box - b.box);
  const unlockedUnrevealed = boxes.filter((b) => !b.playerId && !b.revealedAt).sort((a, b) => a.box - b.box);

  if (mode === 'all') {
    for (const b of [...lockedUnrevealed, ...unlockedUnrevealed]) await store.markBoxRevealed(store.db.query, room.id, b.box);
    await store.finishReveal(store.db.query, room.id);
    return;
  }

  // mode === 'next': reveal the lowest-index unrevealed locked box; once none remain, open the rest and finish.
  if (lockedUnrevealed.length > 0) {
    await store.markBoxRevealed(store.db.query, room.id, lockedUnrevealed[0].box);
    if (lockedUnrevealed.length === 1 && unlockedUnrevealed.length === 0) {
      await store.finishReveal(store.db.query, room.id);
    }
    return;
  }
  if (unlockedUnrevealed.length > 0) {
    for (const b of unlockedUnrevealed) await store.markBoxRevealed(store.db.query, room.id, b.box);
  }
  await store.finishReveal(store.db.query, room.id);
}

/** Builds the game-specific parts of RoomView: `boxes` and `me.claimCode`. RoomService fills in the rest. */
function view({ room, players, boxes, drawCodes, prizesById }, viewer) {
  const boxRowByIndex = new Map(boxes.map((b) => [b.box, b]));
  const lockedByIndex = new Map();
  for (const p of players) {
    if (p.lockedBox !== null && p.lockedBox !== undefined) lockedByIndex.set(p.lockedBox, p.id);
  }

  const boxesOut = [];
  for (let i = 0; i < room.boxCount; i++) {
    const row = boxRowByIndex.get(i);
    const revealed = Boolean(row && row.revealedAt);
    let prize = null;
    if (revealed && row.prizeId) {
      const p = prizesById.get(row.prizeId);
      if (p) prize = publicPrize(p);
    }
    const playerId = revealed ? row.playerId || null : lockedByIndex.get(i) ?? null;
    boxesOut.push({ box: i, revealed, prize, playerId });
  }

  let claimCodeOut = null;
  if (viewer.playerId) {
    const myBox = boxes.find((b) => b.playerId === viewer.playerId && b.revealedAt && b.drawId);
    if (myBox) claimCodeOut = drawCodes[myBox.drawId] ?? null;
  }

  return { boxes: boxesOut, me: { claimCode: claimCodeOut } };
}

module.exports = {
  id: 'mysteryBox',
  start,
  actions: { lock, unlock, countdown, reveal },
  view,
  onCountdownEnd,
};
