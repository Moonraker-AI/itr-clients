/**
 * Smoke retreat seeder — creates a fresh test client + retreat in the
 * connected DB and prints the public client URL for browser walkthrough.
 *
 * Each run creates a NEW client (timestamped email) so re-running gives a
 * fresh client_token. Cleanup is manual (delete via SQL or admin cancel).
 *
 * Local dev usage (cloud-sql-proxy + LOCAL_DB_URL):
 *   npm run smoke:retreat
 *
 * Cloud Run Job usage (against dev/prod DB without local proxy):
 *   bash scripts/run-smoke-seed.sh dev
 *   bash scripts/run-smoke-seed.sh prod
 *
 * The Cloud Run Job (`itr-smoke-seed`) is deployed by the standard
 * cloudbuild.yaml on every push to main / tag, mirroring the
 * itr-migrate Job pattern. The Job is NOT auto-executed by Cloud
 * Build — fire it manually via the helper script above when needed.
 */

import { asc, eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import {
  clients,
  pricingConfig,
  retreatRequiredConsents,
  retreats,
  therapists,
} from '../db/schema.js';
import { syncConsentTemplatesToDb } from '../lib/consent-templates.js';
import { computePrice } from '../lib/pricing.js';
import { transitions } from '../lib/state-machine.js';
import { generateClientToken } from '../lib/tokens.js';

async function main() {
  const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080';
  const { db, pool } = await getDb();

  // Pick the first active therapist as the smoke owner.
  const [t] = await db
    .select()
    .from(therapists)
    .where(eq(therapists.active, true))
    .orderBy(asc(therapists.fullName))
    .limit(1);
  if (!t) {
    console.error('No active therapist found. Run db:seed first.');
    process.exit(1);
  }

  const [pc] = await db
    .select()
    .from(pricingConfig)
    .where(eq(pricingConfig.id, 'singleton'));
  const achDiscountPct = pc ? Number(pc.achDiscountPct) : 0.03;
  const affirmUpliftPct = pc ? Number(pc.affirmUpliftPct) : 0.1;

  const plannedFullDays = 2;
  const plannedHalfDays = 0;
  const fullDayRateCents = t.defaultFullDayCents;
  const halfDayRateCents = t.defaultHalfDayCents;
  const paymentMethod = 'card' as const;
  const price = computePrice({
    fullDayRateCents,
    halfDayRateCents,
    plannedFullDays,
    plannedHalfDays,
    achDiscountPct,
    affirmUpliftPct,
    paymentMethod,
  });

  const templateIds = await syncConsentTemplatesToDb();
  if (templateIds.size === 0) {
    console.error('No active consent templates. Check src/consents/.');
    process.exit(1);
  }

  const stamp = Math.floor(Date.now() / 1000);
  const email = `smoke-${stamp}@moonraker.ai`;

  const result = await db.transaction(async (tx) => {
    const [client] = await tx
      .insert(clients)
      .values({
        firstName: 'Smoke',
        lastName: `Test-${stamp}`,
        email,
        stateOfResidence: 'MA',
        createdByTherapistId: t.id,
      })
      .returning({ id: clients.id });
    if (!client) throw new Error('client insert failed');

    const [retreat] = await tx
      .insert(retreats)
      .values({
        clientId: client.id,
        therapistId: t.id,
        locationId: t.primaryLocationId,
        state: 'draft',
        plannedFullDays,
        plannedHalfDays,
        paymentMethod,
        fullDayRateCents,
        halfDayRateCents,
        achDiscountPct: achDiscountPct.toFixed(4),
        totalPlannedCents: price.totalCents,
        depositCents: fullDayRateCents,
        pricingBasis: 'standard',
        clientToken: generateClientToken(),
      })
      .returning({ id: retreats.id, clientToken: retreats.clientToken });
    if (!retreat) throw new Error('retreat insert failed');

    // Smoke retreat seeds as a standard ITR program. Skip every kair-*
    // template so the ITR consent flow stays clean (KAIR templates are
    // covered by a separate seed once we add a kair smoke variant).
    for (const [name, tpl] of templateIds) {
      if (name.startsWith('kair-')) continue;
      await tx.insert(retreatRequiredConsents).values({
        retreatId: retreat.id,
        templateId: tpl.id,
      });
    }
    return retreat;
  });

  await transitions.sendConsentPackage({
    retreatId: result.id,
    actor: { kind: 'therapist', id: t.id },
  });

  const publicUrl = `${baseUrl}/c/${result.clientToken}`;
  const adminUrl = `${baseUrl}/admin/clients/${result.id}`;

  console.log('');
  console.log('────────────────────────────────────────────────');
  console.log('Smoke retreat created');
  console.log('────────────────────────────────────────────────');
  console.log(`retreat_id   : ${result.id}`);
  console.log(`client_email : ${email}`);
  console.log(`therapist    : ${t.fullName}`);
  console.log(`total        : ${price.totalCents / 100} USD`);
  console.log(`deposit      : ${fullDayRateCents / 100} USD`);
  console.log('');
  console.log(`Public URL   : ${publicUrl}`);
  console.log(`Admin URL    : ${adminUrl}`);
  console.log(`Sign URL     : ${publicUrl}/consents`);
  console.log('────────────────────────────────────────────────');
  console.log('');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
