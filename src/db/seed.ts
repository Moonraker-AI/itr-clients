/**
 * Idempotent seed: locations, therapists, pricing_config singleton.
 *
 * Source of truth for therapist roster + rates: DESIGN.md §4.
 *
 * Run locally against dev (with cloud-sql-proxy + LOCAL_DB_URL):
 *   npm run db:seed
 *
 * Safe to re-run — every upsert keys on a stable slug/id.
 */

import { sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { locations, pricingConfig, therapists } from './schema.js';

const LOCATIONS = [
  {
    slug: 'northampton-ma',
    name: 'Northampton, MA',
    city: 'Northampton',
    state: 'MA',
  },
  {
    slug: 'east-granby-ct',
    name: 'East Granby, CT',
    city: 'East Granby',
    state: 'CT',
  },
  { slug: 'beacon-ny', name: 'Beacon, NY', city: 'Beacon', state: 'NY' },
  { slug: 'auburn-ca', name: 'Auburn, CA', city: 'Auburn', state: 'CA' },
] as const;

type TherapistSeed = {
  slug: string;
  fullName: string;
  email: string;
  role: 'admin' | 'therapist';
  locationSlug: string;
  fullDayCents: number;
  halfDayCents: number | null;
};

const THERAPISTS: TherapistSeed[] = [
  {
    slug: 'amy-shuman',
    fullName: 'Amy Shuman',
    email: 'amy@intensivetherapyretreat.com',
    role: 'therapist',
    locationSlug: 'northampton-ma',
    fullDayCents: 155_000,
    halfDayCents: 83_000,
  },
  {
    slug: 'bambi-rattner',
    fullName: 'Bambi Rattner',
    email: 'bambi@intensivetherapyretreat.com',
    role: 'therapist',
    locationSlug: 'northampton-ma',
    fullDayCents: 155_000,
    halfDayCents: 83_000,
  },
  {
    slug: 'jordan-hamilton',
    fullName: 'Jordan Hamilton',
    email: 'jordan@intensivetherapyretreat.com',
    role: 'therapist',
    locationSlug: 'auburn-ca',
    fullDayCents: 200_000,
    halfDayCents: null,
  },
  {
    slug: 'nikki-gamache',
    fullName: 'Nikki Gamache',
    email: 'nikki@intensivetherapyretreat.com',
    role: 'therapist',
    locationSlug: 'northampton-ma',
    fullDayCents: 155_000,
    halfDayCents: 83_000,
  },
  {
    slug: 'ross-hackerson',
    fullName: 'Ross Hackerson',
    email: 'ross@intensivetherapyretreat.com',
    role: 'admin',
    locationSlug: 'northampton-ma',
    fullDayCents: 240_000,
    halfDayCents: null,
  },
  {
    slug: 'vickie-alston',
    fullName: 'Vickie Alston',
    email: 'vickie@intensivetherapyretreat.com',
    role: 'therapist',
    locationSlug: 'east-granby-ct',
    fullDayCents: 155_000,
    halfDayCents: 83_000,
  },
];

async function main() {
  const { db, pool } = await getDb();
  try {
    const locationIdBySlug = new Map<string, string>();
    for (const l of LOCATIONS) {
      const [row] = await db
        .insert(locations)
        .values(l)
        .onConflictDoUpdate({
          target: locations.slug,
          set: { name: l.name, city: l.city, state: l.state, active: true },
        })
        .returning({ id: locations.id, slug: locations.slug });
      if (!row) throw new Error(`failed to upsert location ${l.slug}`);
      locationIdBySlug.set(row.slug, row.id);
    }

    for (const t of THERAPISTS) {
      const locId = locationIdBySlug.get(t.locationSlug);
      if (!locId) throw new Error(`unknown location slug: ${t.locationSlug}`);
      await db
        .insert(therapists)
        .values({
          slug: t.slug,
          fullName: t.fullName,
          email: t.email,
          role: t.role,
          primaryLocationId: locId,
          defaultFullDayCents: t.fullDayCents,
          defaultHalfDayCents: t.halfDayCents,
        })
        .onConflictDoUpdate({
          target: therapists.slug,
          set: {
            fullName: t.fullName,
            email: t.email,
            role: t.role,
            primaryLocationId: locId,
            defaultFullDayCents: t.fullDayCents,
            defaultHalfDayCents: t.halfDayCents,
            active: true,
          },
        });
    }

    await db
      .insert(pricingConfig)
      .values({ id: 'singleton' })
      .onConflictDoNothing({ target: pricingConfig.id });

    const counts = await db.execute(sql`
      select
        (select count(*) from locations) as locations,
        (select count(*) from therapists) as therapists,
        (select count(*) from pricing_config) as pricing_config
    `);
    console.log('seed complete:', counts.rows[0]);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
