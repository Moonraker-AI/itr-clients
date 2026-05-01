/**
 * /admin/clients/new — create client + retreat + send consent package.
 *
 * GET   renders a single-page HTML form (no JS dependency).
 * POST  validates input, snapshots pricing onto the retreat, generates the
 *       client_token, seeds `retreat_required_consents` for every active
 *       template version, and fires the `sendConsentPackage` transition.
 *
 * Auth is deferred to M8 (DESIGN.md §12). Until then this lives behind
 * Cloud Run IAM auth on the service URL — same blast radius as the rest
 * of the app.
 */

import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  clients,
  pricingConfig,
  retreatRequiredConsents,
  retreats,
  therapists,
} from '../../db/schema.js';
import { syncConsentTemplatesToDb } from '../../lib/consent-templates.js';
import { computePrice, formatCents } from '../../lib/pricing.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';
import { generateClientToken } from '../../lib/tokens.js';

export const adminClientsNewRoute = new Hono();

adminClientsNewRoute.get('/', async (c) => {
  const { db } = await getDb();
  const therapistRows = await db
    .select({
      id: therapists.id,
      slug: therapists.slug,
      fullName: therapists.fullName,
      defaultFullDayCents: therapists.defaultFullDayCents,
      defaultHalfDayCents: therapists.defaultHalfDayCents,
    })
    .from(therapists)
    .where(eq(therapists.active, true))
    .orderBy(asc(therapists.fullName));

  return c.html(renderForm({ therapists: therapistRows }));
});

adminClientsNewRoute.post('/', async (c) => {
  const form = await c.req.formData();
  const get = (k: string) => (form.get(k) as string | null) ?? '';
  const getNum = (k: string) => Number(form.get(k) ?? 0);

  const therapistId = get('therapist_id');
  const firstName = get('first_name').trim();
  const lastName = get('last_name').trim();
  const email = get('email').trim().toLowerCase();
  const phone = get('phone').trim() || null;
  const stateOfResidence = get('state_of_residence').trim() || null;
  const plannedFullDays = getNum('planned_full_days');
  const plannedHalfDays = getNum('planned_half_days');
  const paymentMethod = (get('payment_method') as 'ach' | 'card') || 'ach';
  const pricingBasis =
    (get('pricing_basis') as 'standard' | 'sliding_scale' | 'comp') || 'standard';
  const pricingNotes = get('pricing_notes').trim() || null;
  const overrideFullDayDollars = get('override_full_day');
  const overrideHalfDayDollars = get('override_half_day');

  if (!therapistId || !firstName || !lastName || !email) {
    return c.json({ error: 'missing_required_fields' }, 400);
  }
  if (plannedFullDays < 0 || plannedHalfDays < 0 || plannedFullDays + plannedHalfDays === 0) {
    return c.json({ error: 'invalid_day_counts' }, 400);
  }

  const { db } = await getDb();

  const [t] = await db.select().from(therapists).where(eq(therapists.id, therapistId));
  if (!t) return c.json({ error: 'therapist_not_found' }, 400);

  const [pc] = await db
    .select()
    .from(pricingConfig)
    .where(eq(pricingConfig.id, 'singleton'));
  const achDiscountPct = pc ? Number(pc.achDiscountPct) : 0.03;
  const affirmUpliftPct = pc ? Number(pc.affirmUpliftPct) : 0.1;

  const fullDayRateCents =
    overrideFullDayDollars && pricingBasis !== 'standard'
      ? Math.round(Number(overrideFullDayDollars) * 100)
      : t.defaultFullDayCents;
  const halfDayRateCents =
    overrideHalfDayDollars && pricingBasis !== 'standard'
      ? Math.round(Number(overrideHalfDayDollars) * 100)
      : t.defaultHalfDayCents;

  if (plannedHalfDays > 0 && halfDayRateCents == null) {
    return c.json({ error: 'therapist_no_half_day_rate' }, 400);
  }

  const price = computePrice({
    fullDayRateCents,
    halfDayRateCents,
    plannedFullDays,
    plannedHalfDays,
    achDiscountPct,
    affirmUpliftPct,
    paymentMethod,
  });
  const depositCents = fullDayRateCents; // 1 full day per DESIGN §6

  // Sync templates to DB so we have IDs to snapshot. Idempotent + cheap.
  const templateIds = await syncConsentTemplatesToDb();
  if (templateIds.size === 0) {
    return c.json({ error: 'no_active_consent_templates' }, 500);
  }

  const result = await db.transaction(async (tx) => {
    const [client] = await tx
      .insert(clients)
      .values({
        firstName,
        lastName,
        email,
        phone,
        stateOfResidence,
        createdByTherapistId: therapistId,
      })
      .returning({ id: clients.id });
    if (!client) throw new Error('client insert failed');

    const [retreat] = await tx
      .insert(retreats)
      .values({
        clientId: client.id,
        therapistId,
        locationId: t.primaryLocationId,
        state: 'draft',
        plannedFullDays,
        plannedHalfDays,
        paymentMethod,
        fullDayRateCents,
        halfDayRateCents,
        achDiscountPct: achDiscountPct.toFixed(4),
        totalPlannedCents: price.totalCents,
        depositCents,
        pricingBasis,
        pricingNotes,
        clientToken: generateClientToken(),
      })
      .returning({ id: retreats.id, clientToken: retreats.clientToken });
    if (!retreat) throw new Error('retreat insert failed');

    for (const tpl of templateIds.values()) {
      await tx.insert(retreatRequiredConsents).values({
        retreatId: retreat.id,
        templateId: tpl.id,
      });
    }
    return retreat;
  });

  await transitions.sendConsentPackage({
    retreatId: result.id,
    actor: { kind: 'therapist', id: therapistId },
  });

  log.info('admin_client_created', {
    retreatId: result.id,
    therapistId,
  });
  return c.redirect(`/admin/clients/${result.id}`);
});

interface TherapistOption {
  id: string;
  slug: string;
  fullName: string;
  defaultFullDayCents: number;
  defaultHalfDayCents: number | null;
}

function renderForm(args: { therapists: TherapistOption[] }): string {
  const therapistOptions = args.therapists
    .map(
      (t) =>
        `<option value="${escAttr(t.id)}" data-full="${t.defaultFullDayCents}" data-half="${
          t.defaultHalfDayCents ?? ''
        }">${escHtml(t.fullName)} (${formatCents(t.defaultFullDayCents)} / ${
          t.defaultHalfDayCents == null ? '—' : formatCents(t.defaultHalfDayCents)
        })</option>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>New client + retreat — ITR Client HQ</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-weight: 600; }
    fieldset { border: 1px solid #ddd; padding: 1rem 1.2rem; margin-bottom: 1rem; }
    legend { font-weight: 600; padding: 0 0.4rem; }
    label { display: block; margin-bottom: 0.6rem; }
    label span { display: inline-block; width: 200px; }
    input, select, textarea { padding: 0.4rem; font: inherit; }
    input[type=text], input[type=email], input[type=number], select, textarea { width: 320px; }
    textarea { vertical-align: top; height: 4rem; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    .hint { color: #666; font-size: 12px; margin-left: 200px; }
  </style>
</head>
<body>
  <h1>New client + retreat</h1>
  <form method="post">
    <fieldset>
      <legend>Therapist</legend>
      <label>
        <span>Therapist</span>
        <select name="therapist_id" required>
          <option value="">Select…</option>
          ${therapistOptions}
        </select>
      </label>
    </fieldset>

    <fieldset>
      <legend>Client</legend>
      <label><span>First name</span><input name="first_name" type="text" required></label>
      <label><span>Last name</span><input name="last_name" type="text" required></label>
      <label><span>Email</span><input name="email" type="email" required></label>
      <label><span>Phone</span><input name="phone" type="text"></label>
      <label><span>State of residence</span><input name="state_of_residence" type="text" maxlength="2" placeholder="MA"></label>
    </fieldset>

    <fieldset>
      <legend>Retreat</legend>
      <label><span>Full days</span><input name="planned_full_days" type="number" min="0" step="1" value="0" required></label>
      <label><span>Half days</span><input name="planned_half_days" type="number" min="0" step="1" value="0" required></label>
      <label>
        <span>Payment method</span>
        <select name="payment_method">
          <option value="ach">ACH</option>
          <option value="card">Card</option>
        </select>
      </label>
    </fieldset>

    <fieldset>
      <legend>Pricing</legend>
      <label>
        <span>Basis</span>
        <select name="pricing_basis">
          <option value="standard">Standard</option>
          <option value="sliding_scale">Sliding scale</option>
          <option value="comp">Comp</option>
        </select>
      </label>
      <p class="hint">Override rates only when basis is sliding-scale or comp. Leave blank to use therapist default.</p>
      <label><span>Override full-day ($)</span><input name="override_full_day" type="number" min="0" step="0.01"></label>
      <label><span>Override half-day ($)</span><input name="override_half_day" type="number" min="0" step="0.01"></label>
      <label><span>Pricing notes</span><textarea name="pricing_notes" placeholder="Internal — never rendered client-side."></textarea></label>
    </fieldset>

    <button type="submit">Create + send consent package</button>
  </form>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
function escAttr(s: string): string {
  return escHtml(s).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
