/**
 * Idempotent seed: locations, therapists, pricing_config singleton,
 * notification_recipients defaults.
 *
 * Source of truth for therapist roster + rates: DESIGN.md §4.
 * Source of truth for notification recipients: DESIGN.md §8.
 *
 * Run locally against dev (with cloud-sql-proxy + LOCAL_DB_URL):
 *   npm run db:seed
 *
 * Safe to re-run — every upsert keys on a stable slug/id/(event,email).
 */

import { sql } from 'drizzle-orm';
import { getDb } from './client.js';
import {
  locations,
  notificationRecipients,
  pricingConfig,
  therapists,
} from './schema.js';

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

    // Notification recipients (DESIGN §8). The shared inbox gets every
    // event. Per-therapist notifications are NOT seeded here — they are
    // resolved at send time in `notify()` via retreat.therapist_id, so
    // each therapist only sees their own retreats' events. (M2 originally
    // seeded a row per therapist per action-required event; that caused
    // notification fan-out to all therapists. Removed in 0003 migration.)
    const TEAM = 'support@intensivetherapyretreat.com';
    const ALL_EVENTS = [
      'consent_package_sent',
      'consents_signed',
      'deposit_paid',
      'dates_confirmed',
      'in_progress',
      'completion_submitted',
      'final_charged',
      'final_charge_failed',
      'final_charge_retry_exhausted',
      'cancelled',
    ] as const;

    const notifyRows: { eventType: string; email: string }[] = [];
    for (const ev of ALL_EVENTS) notifyRows.push({ eventType: ev, email: TEAM });
    for (const r of notifyRows) {
      await db
        .insert(notificationRecipients)
        .values(r)
        .onConflictDoUpdate({
          target: [
            notificationRecipients.eventType,
            notificationRecipients.email,
          ],
          set: { active: true },
        });
    }

    const counts = await db.execute(sql`
      select
        (select count(*) from locations) as locations,
        (select count(*) from therapists) as therapists,
        (select count(*) from pricing_config) as pricing_config,
        (select count(*) from notification_recipients) as notification_recipients
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
