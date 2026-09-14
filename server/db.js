import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

// PostgreSQL DATE columns carry no time or offset, so keep them as plain
// 'YYYY-MM-DD' strings instead of letting node-postgres build a Date in the
// process timezone - that conversion can silently shift week_start by a day.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

// Railway's private network does not use TLS; a public/managed URL might.
const needsSsl = /sslmode=require|sslmode=verify/.test(config.databaseUrl);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getRevision(client = pool) {
  const { rows } = await client.query('SELECT revision FROM sync_revision WHERE id = 1');
  return rows.length ? Number(rows[0].revision) : 0;
}

// Redacts credentials so the connection target can be logged safely.
export function describeDatabase() {
  try {
    const url = new URL(config.databaseUrl);
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  } catch {
    return 'unparseable DATABASE_URL';
  }
}
