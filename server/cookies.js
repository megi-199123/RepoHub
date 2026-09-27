'use strict';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    // A malformed percent-escape (e.g. "a=%") throws a URIError from decodeURIComponent; fall back
    // to the raw value instead of letting one bad cookie take down the whole request/socket.
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

module.exports = { parseCookies };
