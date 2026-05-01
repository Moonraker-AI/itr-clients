import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.js';

/**
 * Cloud SQL Postgres connection.
 *
 * Two modes:
 *   - LOCAL_DB_URL set: connect directly. Use with Cloud SQL Auth Proxy
 *     on 127.0.0.1 during local dev, or any standard Postgres URL.
 *   - LOCAL_DB_URL unset: use the Cloud SQL Node.js Connector for an
 *     mTLS-encrypted, IAM-authenticated tunnel to the instance's PRIVATE IP.
 *     CLOUD_SQL_INSTANCE + DB_URL required.
 *
 * Lazy init via getDb() — server.ts in M0 never calls this, so no pool
 * is opened until M1+ code actually queries.
 */

type DbHandle = {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: pg.Pool;
};

let handle: DbHandle | null = null;

export async function getDb(): Promise<DbHandle> {
  if (handle) return handle;

  const pool = await buildPool();

  pool.on('error', (err) => {
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: 'pg_pool_error',
        error: err.message,
      }),
    );
  });

  handle = { db: drizzle(pool, { schema }), pool };
  return handle;
}

async function buildPool(): Promise<pg.Pool> {
  const localUrl = process.env.LOCAL_DB_URL;
  if (localUrl) {
    return new pg.Pool({ connectionString: localUrl, max: 5 });
  }

  const instance = requireEnv('CLOUD_SQL_INSTANCE');
  const { user, password, database } = parseDbUrl(requireEnv('DB_URL'));

  // Migration path: Cloud Run Job mounts /cloudsql/<INSTANCE> as a unix
  // socket via --add-cloudsql-instances. No VPC config required.
  if (process.env.MIGRATE_VIA_SOCKET === '1') {
    return new pg.Pool({
      host: `/cloudsql/${instance}`,
      user,
      password,
      database,
      max: 2,
    });
  }

  // Runtime path: mTLS-encrypted, IAM-authenticated tunnel via the Cloud SQL
  // Node.js Connector to the instance's PRIVATE IP. Requires Cloud Run
  // VPC egress (configured at the service level).
  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PRIVATE,
  });

  return new pg.Pool({
    ...clientOpts,
    user,
    password,
    database,
    max: 5, // Cloud Run is small + scales to zero. Keep it tight.
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}

/**
 * Parse a Postgres DSN without ever surfacing the secret on failure.
 *
 * `new URL(dsn)` is convenient but its TypeError attaches `input` to the
 * thrown object, which means any unhandled parse failure prints the full
 * connection string — including the password — to stderr. This wrapper
 * catches that and rethrows a generic error. Passwords with reserved URL
 * chars (`/`, `@`, `:`, `?`, `#`, `&`) MUST be percent-encoded in the
 * stored secret.
 */
function parseDbUrl(dsn: string): {
  user: string;
  password: string;
  database: string;
} {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error('DB_URL parse failed (check that password is URL-encoded)');
  }
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || 'itr_app',
  };
}
