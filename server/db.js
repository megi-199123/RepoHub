'use strict';

const path = require('path');

/**
 * A tiny database handle with the same shape for both drivers:
 *   query(sql, params) -> rows
 *   tx(async (query) => ...) -> runs the callback inside a transaction
 *
 * With DATABASE_URL set we use a regular Postgres pool (Railway, Neon, Supabase, …).
 * Without it we fall back to PGlite, an embedded Postgres, so local development
 * and tests need no database server.
 */
async function openDatabase({ databaseUrl, dataDir, memory = false } = {}) {
  if (databaseUrl) return openPostgres(databaseUrl);
  return openPglite(memory ? undefined : path.join(dataDir, 'pglite'));
}

function openPostgres(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    // Serverless functions each hold their own pool, so keep it small there.
    max: Number(process.env.PG_POOL_MAX) || (process.env.VERCEL ? 3 : 10),
    idleTimeoutMillis: 10_000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));

  return {
    driver: 'postgres',
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(async (sql, params) => (await client.query(sql, params)).rows);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dir) {
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch {
    throw new Error('DATABASE_URL is not set. Point it at your Postgres database (e.g. Railway or Neon).');
  }
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    driver: 'pglite',
    query: async (sql, params) => (await db.query(sql, params)).rows,
    tx: (fn) => db.transaction((tx) => fn(async (sql, params) => (await tx.query(sql, params)).rows)),
    close: () => db.close(),
  };
}

module.exports = { openDatabase };
