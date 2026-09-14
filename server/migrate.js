import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRequiredConfig } from './config.js';
import { pool, describeDatabase } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, 'migrations');

export async function runMigrations() {
  const client = await pool.connect();
  try {
    // Advisory lock: two instances booting at once must not race the schema.
    await client.query('SELECT pg_advisory_lock(873_112_455)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    console.log(
      count === 0
        ? `[migrate] schema up to date (${files.length} migration(s))`
        : `[migrate] applied ${count} migration(s)`
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock(873_112_455)').catch(() => {});
    client.release();
  }
}

// Allow `npm run migrate` as a standalone command.
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  assertRequiredConfig(['databaseUrl']);
  console.log(`[migrate] target ${describeDatabase()}`);
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err.message);
      process.exit(1);
    });
}
