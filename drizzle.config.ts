import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config. Used for `generate` and `studio` only — the
 * runtime app uses src/db/client.ts (with the Cloud SQL Connector).
 *
 * Local flow:
 *   1. cloud-sql-proxy itr-clients-dev:us-central1:itr-postgres-dev --port 5432
 *   2. set DEV_DB_URL in .env.local
 *   3. npm run db:generate / db:studio
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DEV_DB_URL ?? '',
  },
  strict: true,
  verbose: true,
});
