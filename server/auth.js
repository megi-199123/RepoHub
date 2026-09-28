'use strict';

const crypto = require('crypto');

const KEY_LEN = 64;

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, KEY_LEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Returns `salt:hash` (both hex) for storage in users.password_hash. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt);
  return `${salt}:${key.toString('hex')}`;
}

/** Constant-time compare against a `salt:hash` string. Never throws on a malformed/missing hash. */
async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  let expected;
  try {
    expected = Buffer.from(hex, 'hex');
  } catch {
    return false;
  }
  const key = await scryptAsync(password, salt);
  if (key.length !== expected.length) return false;
  return crypto.timingSafeEqual(key, expected);
}

module.exports = { hashPassword, verifyPassword };
