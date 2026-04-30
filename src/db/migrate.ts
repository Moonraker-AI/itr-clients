/**
 * Standalone migration runner.
 *
 * Local: `npm run db:migrate` against dev via Cloud SQL Auth Proxy
 * (with LOCAL_DB_URL set in .env.local).
 *
 * In CI: not yet wired into infra/cloudbuild.yaml — empty schema in M0,
 * deferred until M1.
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb } from './client.js';

const { db, pool } = await getDb();
try {
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('migrations applied');
} finally {
  await pool.end();
}
