'use strict';

/**
 * A tiny in-memory fixed-window rate limiter, keyed by whatever string the caller passes
 * (e.g. an IP address or `${ip}:${action}`). Good enough for a single process; if RepoHub
 * ever runs multiple instances behind a shared load balancer this would need a shared store.
 */
function createLimiter({ max, windowMs }) {
  const hits = new Map(); // key -> { count, resetAt }

  const prune = (now) => {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  };

  // Keeps the map from growing forever even for keys that stop being hit.
  const sweep = setInterval(() => prune(Date.now()), Math.max(windowMs, 1000));
  sweep.unref();

  return {
    /** Returns true when the call is allowed, false when the key is over its limit. */
    hit(key) {
      const now = Date.now();
      prune(now);
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= max;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// UNVERIFIED: assumes the hosting edge (Railway) APPENDS the client address to X-Forwarded-For. If it forwards a client-supplied header unchanged, the rightmost entry is spoofable too. Verify after cutover (runbook step R7).
function clientIp(req) {
  const header = req.headers['x-forwarded-for'];
  if (header) {
    const parts = String(header).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || '';
}

module.exports = { createLimiter, clientIp };
