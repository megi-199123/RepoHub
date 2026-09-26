'use strict';

/** A prize can end up in a box when it is active, has weight, and has stock left. */
function isAvailable(prize) {
  return prize.active && prize.weight > 0 && (prize.stock === null || prize.stock > 0);
}

function weightedPick(pool, rand = Math.random) {
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  let roll = rand() * total;
  for (const p of pool) {
    roll -= p.weight;
    if (roll < 0) return p;
  }
  return pool[pool.length - 1];
}

/**
 * Fill `boxCount` boxes with prize ids.
 *
 * - "unique":   boxes get distinct prizes while there are enough of them
 *               (weighted sampling without replacement). If there are fewer
 *               prizes than boxes, the remaining boxes are filled by weight.
 * - "weighted": every box is an independent weighted draw, so duplicates are
 *               possible and weight maps directly to odds.
 */
function fillBoxes(prizes, boxCount, assignment, rand = Math.random) {
  const available = prizes.filter(isAvailable);
  if (available.length === 0) return null;

  const boxes = [];
  if (assignment === 'unique') {
    const pool = [...available];
    while (boxes.length < boxCount && pool.length > 0) {
      const pick = weightedPick(pool, rand);
      boxes.push(pick.id);
      pool.splice(pool.indexOf(pick), 1);
    }
    // Shuffle so the weighted order doesn't leak into box positions.
    for (let i = boxes.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [boxes[i], boxes[j]] = [boxes[j], boxes[i]];
    }
  }
  while (boxes.length < boxCount) boxes.push(weightedPick(available, rand).id);
  return boxes;
}

/**
 * Estimate each prize's chance of being won: the player picks a random box,
 * so the win chance is the expected share of boxes holding that prize.
 */
function estimateOdds(prizes, boxCount, assignment, rounds = 20000) {
  const counts = Object.fromEntries(prizes.map((p) => [p.id, 0]));
  for (let i = 0; i < rounds; i++) {
    const boxes = fillBoxes(prizes, boxCount, assignment);
    if (!boxes) return {};
    for (const id of boxes) counts[id] += 1 / boxCount;
  }
  return Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, n / rounds]));
}

module.exports = { isAvailable, weightedPick, fillBoxes, estimateOdds };
