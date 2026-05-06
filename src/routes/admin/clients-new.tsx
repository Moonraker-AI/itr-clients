/**
 * /admin/clients/new - create client + retreat + send consent package.
 *
 * GET   renders a single-page JSX form (no JS dependency).
 * POST  validates input, snapshots pricing onto the retreat, generates the
 *       client_token, seeds `retreat_required_consents` for every active
 *       template version, and fires the `sendConsentPackage` transition.
 *
 * Auth: gated behind the M8 requireAuth middleware. CSRF protected via
 * the double-submit cookie + hidden input pattern (lib/csrf.ts).
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
import { ensureCsrfToken, verifyCsrfToken } from '../../lib/csrf.js';
import { computePrice, formatCents } from '../../lib/pricing.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';
import { generateClientToken } from '../../lib/tokens.js';
import {
  AdminShell,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CsrfInput,
  Field,
  Input,
  Layout,
  PageHeader,
  Select,
  Textarea,
} from '../../lib/ui/index.js';

export const adminClientsNewRoute = new Hono();

interface TherapistOption {
  id: string;
  slug: string;
  fullName: string;
  defaultFullDayCents: number;
  defaultHalfDayCents: number | null;
}

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

  const csrfToken = ensureCsrfToken(c);
  const user = c.get('user');
  const isTherapist = user?.role === 'therapist';
  const selfTherapist = isTherapist
    ? (therapistRows as TherapistOption[]).find((t) => t.id === user.therapistId)
    : null;

  return c.html(
    <Layout title="New client + retreat - ITR Clients">
      <AdminShell user={user} current="new">
        <PageHeader title="New client + retreat" description="Create record and send the consent package." />

        <form method="post" class="space-y-6 max-w-2xl">
          <CsrfInput token={csrfToken} />

          <Card>
            <CardHeader>
              <CardTitle>Therapist</CardTitle>
            </CardHeader>
            <CardContent>
              {isTherapist && selfTherapist ? (
                <>
                  <input type="hidden" name="therapist_id" value={selfTherapist.id} />
                  <div class="space-y-1">
                    <div class="text-sm font-medium">{selfTherapist.fullName}</div>
                    <div class="text-xs text-muted-foreground">
                      {formatCents(selfTherapist.defaultFullDayCents)} full day
                      {selfTherapist.defaultHalfDayCents != null
                        ? ` · ${formatCents(selfTherapist.defaultHalfDayCents)} half day`
                        : ''}
                    </div>
                  </div>
                </>
              ) : (
                <Field label="Therapist" for="therapist_id">
                  <Select id="therapist_id" name="therapist_id" required>
                    <option value="">Select…</option>
                    {(therapistRows as TherapistOption[]).map((t) => (
                      <option value={t.id}>
                        {t.fullName} ({formatCents(t.defaultFullDayCents)} /{' '}
                        {t.defaultHalfDayCents == null ? '-' : formatCents(t.defaultHalfDayCents)})
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Client</CardTitle>
            </CardHeader>
            <CardContent class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="First name" for="first_name">
                <Input id="first_name" name="first_name" required />
              </Field>
              <Field label="Last name" for="last_name">
                <Input id="last_name" name="last_name" required />
              </Field>
              <Field label="Email" for="email">
                <Input id="email" name="email" type="email" required />
              </Field>
              <Field label="Phone" for="phone">
                <Input id="phone" name="phone" />
              </Field>
              <Field label="State of residence" for="state_of_residence" hint="2-letter abbreviation">
                <Input
                  id="state_of_residence"
                  name="state_of_residence"
                  placeholder="MA"
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Retreat</CardTitle>
            </CardHeader>
            <CardContent class="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Full days" for="planned_full_days">
                <Input
                  id="planned_full_days"
                  name="planned_full_days"
                  type="number"
                  min="0"
                  step="1"
                  value="0"
                  required
                />
              </Field>
              <Field label="Half days" for="planned_half_days">
                <Input
                  id="planned_half_days"
                  name="planned_half_days"
                  type="number"
                  min="0"
                  step="1"
                  value="0"
                  required
                />
              </Field>
              <Field label="Payment method" for="payment_method">
                <Select id="payment_method" name="payment_method">
                  <option value="ach">ACH</option>
                  <option value="card">Card</option>
                </Select>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pricing</CardTitle>
            </CardHeader>
            <CardContent class="space-y-4">
              <Field label="Basis" for="pricing_basis">
                <Select id="pricing_basis" name="pricing_basis">
                  <option value="standard">Standard</option>
                  <option value="sliding_scale">Sliding scale</option>
                  <option value="comp">Comp</option>
                </Select>
              </Field>
              <p class="text-xs text-muted-foreground">
                Override rates only when basis is sliding-scale or comp. Leave blank to use therapist default.
              </p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Override full-day ($)" for="override_full_day">
                  <Input id="override_full_day" name="override_full_day" type="number" min="0" step="0.01" />
                </Field>
                <Field label="Override half-day ($)" for="override_half_day">
                  <Input id="override_half_day" name="override_half_day" type="number" min="0" step="0.01" />
                </Field>
              </div>
              <Field label="Pricing notes" for="pricing_notes" hint="Internal - never rendered client-side.">
                <Textarea id="pricing_notes" name="pricing_notes" rows={3} />
              </Field>
            </CardContent>
          </Card>

          <div class="flex gap-3">
            <Button type="submit" size="lg">
              Create + send consent package
            </Button>
          </div>
        </form>
      </AdminShell>
    </Layout>,
  );
});

adminClientsNewRoute.post('/', async (c) => {
  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
  const get = (k: string) => (form.get(k) as string | null) ?? '';
  const getNum = (k: string) => Number(form.get(k) ?? 0);

  // P2#16: when role=therapist, force therapist_id to the session's
  // therapist regardless of submitted form value. Defense-in-depth so a
  // therapist can't create retreats on behalf of another therapist by
  // tampering with the hidden input.
  const sessionUser = c.get('user');
  const therapistId =
    sessionUser?.role === 'therapist' ? sessionUser.therapistId : get('therapist_id');
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
  // Audit tier-10 - defensive bounds on free-text fields. clients.* columns
  // are TEXT (unbounded); without a cap a typo or a paste accident could
  // insert a megabyte of text.
  const FIELD_CAPS = {
    firstName: 80,
    lastName: 80,
    email: 254, // RFC 5321 SMTP limit
    phone: 32,
    stateOfResidence: 64,
    pricingNotes: 1000,
  } as const;
  if (
    firstName.length > FIELD_CAPS.firstName ||
    lastName.length > FIELD_CAPS.lastName ||
    email.length > FIELD_CAPS.email ||
    (phone && phone.length > FIELD_CAPS.phone) ||
    (stateOfResidence && stateOfResidence.length > FIELD_CAPS.stateOfResidence) ||
    (pricingNotes && pricingNotes.length > FIELD_CAPS.pricingNotes)
  ) {
    return c.json({ error: 'field_too_long' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  if (
    !Number.isInteger(plannedFullDays) ||
    !Number.isInteger(plannedHalfDays) ||
    plannedFullDays < 0 ||
    plannedHalfDays < 0 ||
    plannedFullDays + plannedHalfDays === 0 ||
    plannedFullDays + plannedHalfDays > 30
  ) {
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

  const parseDollarOverride = (raw: string): number | null | 'invalid' => {
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 10_000) return 'invalid';
    return Math.round(n * 100);
  };
  let fullDayRateCents = t.defaultFullDayCents;
  let halfDayRateCents = t.defaultHalfDayCents;
  if (pricingBasis !== 'standard') {
    const overrideFull = parseDollarOverride(overrideFullDayDollars);
    if (overrideFull === 'invalid') {
      return c.json({ error: 'invalid_full_day_override' }, 400);
    }
    if (overrideFull != null) fullDayRateCents = overrideFull;

    const overrideHalf = parseDollarOverride(overrideHalfDayDollars);
    if (overrideHalf === 'invalid') {
      return c.json({ error: 'invalid_half_day_override' }, 400);
    }
    if (overrideHalf != null) halfDayRateCents = overrideHalf;
  }

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
