/**
 * Standalone migration runner.
 *
 * Local: `npm run db:migrate` against dev via Cloud SQL Auth Proxy
 * (with LOCAL_DB_URL set in .env.local).
 *
 * In CI: invoked by the `itr-migrate` Cloud Run Job (see infra/cloudbuild.yaml).
 * The Job mounts the Cloud SQL instance at /cloudsql/<INSTANCE> via
 * --add-cloudsql-instances; getDb() picks that up when MIGRATE_VIA_SOCKET=1.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, 'migrations');

const { db, pool } = await getDb();
try {
  await migrate(db, { migrationsFolder });
  console.log(JSON.stringify({ severity: 'INFO', message: 'migrations_applied' }));
} finally {
  await pool.end();
}
