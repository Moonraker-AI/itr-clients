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
  STATIC_V_QS,
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
  kairEligible: boolean;
  kairFullDayCents: number | null;
  kairHalfDayCents: number | null;
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
      kairEligible: therapists.kairEligible,
      kairFullDayCents: therapists.kairFullDayCents,
      kairHalfDayCents: therapists.kairHalfDayCents,
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
    <Layout
      title="New client + retreat - ITR Clients"
      scripts={
        <script
          src={`/static/js/admin-clients-new.js${STATIC_V_QS}`}
          defer
        ></script>
      }
    >
      <AdminShell user={user} current="new">
        <div class="max-w-3xl mx-auto">
          <PageHeader title="New client + retreat" description="Create record and send the consent package." />

          <form method="post" class="space-y-6">
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
                      <option
                        value={t.id}
                        data-kair-eligible={t.kairEligible ? '1' : '0'}
                      >
                        {t.fullName}{t.kairEligible ? ' · KAIR' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </CardContent>
          </Card>

          {/* Retreat type - only relevant when the selected therapist is
              KAIR-eligible. For the self-therapist (non-admin) path, server
              renders unhidden iff their own row is kair_eligible. For the
              admin dropdown path, server renders hidden + admin-shell.js
              toggles visibility based on the selected option's
              data-kair-eligible attribute. The hidden input ensures
              program=itr is submitted when the field is invisible. */}
          <div
            id="retreat-type-block"
            hidden={isTherapist && selfTherapist ? !selfTherapist.kairEligible : true}
          >
            <Card>
              <CardHeader>
                <CardTitle>Retreat type</CardTitle>
              </CardHeader>
              <CardContent>
                <Field label="Program" for="program">
                  <Select id="program" name="program">
                    <option value="itr">Standard ITR</option>
                    <option value="kair">KAIR (Ketamine-Assisted Intensive Retreat)</option>
                  </Select>
                </Field>
              </CardContent>
            </Card>
          </div>

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
            <CardContent class="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                  <option value="custom">Custom</option>
                </Select>
              </Field>
              {/* `hidden` by default; admin-clients-new.js flips it whenever
                  the Basis select moves to/from `custom`. Pre-script-load
                  the inputs stay hidden, so an admin who form-submits before
                  JS hydrates can't accidentally send override values for a
                  standard-priced retreat. */}
              <div id="pricing-custom-fields" class="space-y-4" hidden>
                <p class="text-xs text-muted-foreground">
                  Set any price - higher than the therapist default, lower, or $0 for a comp.
                </p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Custom full-day ($)" for="override_full_day">
                    <Input id="override_full_day" name="override_full_day" type="number" min="0" step="1" />
                  </Field>
                  <Field label="Custom half-day ($)" for="override_half_day">
                    <Input id="override_half_day" name="override_half_day" type="number" min="0" step="1" />
                  </Field>
                </div>
                <Field label="Pricing notes" for="pricing_notes" hint="Internal - never rendered client-side.">
                  <Textarea id="pricing_notes" name="pricing_notes" rows={3} />
                </Field>
              </div>
            </CardContent>
          </Card>

          <div class="flex gap-3">
            <Button type="submit" size="lg">
              Create + send consent package
            </Button>
          </div>
          </form>
        </div>
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
  // v0.28.21: payment method is no longer collected on the new-client
  // form. The client picks card vs ACH at /c/<token>/checkout, where the
  // chooser applies the ACH discount at session-creation time. The DB
  // column keeps its 'ach' default purely as an audit/display value on
  // the retreat detail page.
  const paymentMethod: 'ach' | 'card' = 'ach';
  // v0.28.17: form collapses to Standard | Custom. DB enum still carries
  // legacy `sliding_scale` and `comp` for backwards-compat with old
  // retreats; we map Custom -> comp if both overrides come in as $0
  // (full comp), else -> sliding_scale. Keeps the detail page +
  // historical rows readable without a migration.
  const pricingBasisForm =
    (get('pricing_basis') as 'standard' | 'custom') || 'standard';
  const isCustom = pricingBasisForm === 'custom';
  const overrideFullStr = get('override_full_day').trim();
  const overrideHalfStr = get('override_half_day').trim();
  const isCompShape =
    isCustom &&
    overrideFullStr !== '' &&
    Number(overrideFullStr) === 0 &&
    (overrideHalfStr === '' || Number(overrideHalfStr) === 0);
  const pricingBasis: 'standard' | 'sliding_scale' | 'comp' = isCustom
    ? isCompShape
      ? 'comp'
      : 'sliding_scale'
    : 'standard';
  const pricingNotes = get('pricing_notes').trim() || null;
  const overrideFullDayDollars = get('override_full_day');
  const overrideHalfDayDollars = get('override_half_day');
  // KAIR program (v0.23.0). Hidden from the form when the selected therapist
  // is not kair-eligible; defaulted to 'itr' on submit either way. The
  // server-side gate below enforces the eligibility constraint regardless.
  const programRaw = (get('program') as 'itr' | 'kair') || 'itr';
  const program: 'itr' | 'kair' = programRaw === 'kair' ? 'kair' : 'itr';

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
  // Program-aware base rates. KAIR retreats use the therapist's KAIR rates;
  // ITR uses the standard defaults. Server-side eligibility check is the
  // authoritative one - the UI hides the option for non-eligible therapists
  // but a tampered form must still be rejected.
  if (program === 'kair') {
    if (!t.kairEligible) {
      return c.json({ error: 'therapist_not_kair_eligible' }, 400);
    }
    if (t.kairFullDayCents == null) {
      return c.json({ error: 'therapist_missing_kair_rate' }, 400);
    }
  }
  let fullDayRateCents =
    program === 'kair' && t.kairFullDayCents != null
      ? t.kairFullDayCents
      : t.defaultFullDayCents;
  let halfDayRateCents =
    program === 'kair' ? t.kairHalfDayCents : t.defaultHalfDayCents;
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
        program,
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

    // Program-aware template set:
    //   ITR retreats: skip every kair-* template (main consent + portal
    //     resources from v0.24.0).
    //   KAIR retreats: skip the standard 'informed-consent' (replaced by
    //     'kair-informed-consent') but include the kair-* portal resources
    //     so they show up on /c/[token]/resources after signing.
    // Shared templates (NPP, emergency-contact-release) attach to both.
    for (const [name, tpl] of templateIds) {
      if (program === 'kair' && name === 'informed-consent') continue;
      if (program !== 'kair' && name.startsWith('kair-')) continue;
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
