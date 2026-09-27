'use strict';

const crypto = require('crypto');

/** Human-friendly claim code without ambiguous characters (no 0/O, 1/I). Shared by the solo route and room reveals. */
function claimCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return `MB-${code.slice(0, 4)}-${code.slice(4)}`;
}

module.exports = { claimCode };
