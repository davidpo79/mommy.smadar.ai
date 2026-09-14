/**
 * Optional seed data.
 *
 * These five names come from the Claude Design prototype that this application
 * was built from. They are NOT inserted automatically on deploy - run
 * `npm run seed` explicitly if you want the prototype roster in the database.
 * The command is idempotent: a caregiver whose name already exists is skipped.
 */
import { assertRequiredConfig } from './config.js';
import { pool, describeDatabase } from './db.js';
import { runMigrations } from './migrate.js';

const PROTOTYPE_ROSTER = [
  { name: 'יפעת', paid: false, rate: 0 },
  { name: 'רוני', paid: false, rate: 0 },
  { name: 'שיר עובדיה', paid: true, rate: 50 },
  { name: 'מור גניש', paid: true, rate: 50 },
  { name: 'מיה סלומון', paid: true, rate: 50 },
];

async function seed() {
  assertRequiredConfig(['databaseUrl']);
  console.log(`[seed] target ${describeDatabase()}`);
  await runMigrations();

  let inserted = 0;
  for (const [index, person] of PROTOTYPE_ROSTER.entries()) {
    const { rowCount } = await pool.query(
      `INSERT INTO caregivers (name, paid, hourly_rate, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [person.name, person.paid, person.rate, index]
    );
    inserted += rowCount;
  }
  console.log(`[seed] inserted ${inserted} caregiver(s), skipped ${PROTOTYPE_ROSTER.length - inserted}`);
  await pool.end();
}

seed().catch((err) => {
  console.error('[seed] failed:', err.message);
  process.exit(1);
});
