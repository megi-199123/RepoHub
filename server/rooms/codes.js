'use strict';

const crypto = require('crypto');

/** A short, human-friendly 6-digit room code (leading zeros allowed). */
function roomCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

module.exports = { roomCode };
