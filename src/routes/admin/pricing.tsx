/**
 * /admin/pricing - read existing per-therapist rates + edit ach_discount_pct.
 *
 * Auth: gated behind the M8 requireAuth middleware. CSRF protected via
 * the double-submit cookie + hidden input pattern (lib/csrf.ts).
 */

import { Hono } from 'hono';
import { eq, asc } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { pricingConfig, therapists } from '../../db/schema.js';
import { ensureCsrfToken, verifyCsrfToken } from '../../lib/csrf.js';
import { formatCents } from '../../lib/pricing.js';
import { log } from '../../lib/phi-redactor.js';
import {
  AdminShell,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CsrfInput,
  Input,
  Label,
  Layout,
  PageHeader,
  Select,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '../../lib/ui/index.js';

type TherapistRole = 'admin' | 'therapist';
const ROLES: readonly TherapistRole[] = ['admin', 'therapist'];

export const adminPricingRoute = new Hono();

type Row = {
  slug: string;
  fullName: string;
  role: string;
  fullDay: number;
  halfDay: number | null;
  kairEligible: boolean;
  kairFullDay: number | null;
  kairHalfDay: number | null;
  active: boolean;
  connectAccountId: string | null;
  payoutPct: string;
};

adminPricingRoute.get('/', async (c) => {
  // P2#16: pricing is global config - admin-only.
  const user = c.get('user');
  if (user?.role !== 'admin') return c.notFound();

  const { db } = await getDb();

  const rows = await db
    .select({
      slug: therapists.slug,
      fullName: therapists.fullName,
      role: therapists.role,
      fullDay: therapists.defaultFullDayCents,
      halfDay: therapists.defaultHalfDayCents,
      kairEligible: therapists.kairEligible,
      kairFullDay: therapists.kairFullDayCents,
      kairHalfDay: therapists.kairHalfDayCents,
      active: therapists.active,
      connectAccountId: therapists.stripeConnectAccountId,
      payoutPct: therapists.therapistPayoutPct,
    })
    .from(therapists)
    .orderBy(asc(therapists.fullName));

  const [config] = await db
    .select()
    .from(pricingConfig)
    .where(eq(pricingConfig.id, 'singleton'));

  const ach = config ? Number(config.achDiscountPct) : 0.03;
  const csrfToken = ensureCsrfToken(c);
  const pctStr = (ach * 100).toFixed(2);

  return c.html(
    <Layout title="Pricing - ITR Clients">
      <AdminShell user={user} current="pricing" wide>
        <PageHeader title="Pricing" description="Per-therapist rates and ACH discount config." />

        <Card class="mb-6">
          <CardHeader>
            <CardTitle>Per-therapist rates</CardTitle>
            <CardDescription>
              Edit full-day and half-day defaults inline. Existing retreats keep their snapshotted rates; only future retreats inherit the new defaults.
            </CardDescription>
          </CardHeader>
          <CardContent class="px-0">
            {/* HTML5 `form` attribute lets each row's inputs reference a
                separate <form> element rendered outside the table. Keeps the
                per-column alignment intact while still scoping submits. */}
            <div class="hidden">
              {(rows as Row[]).map((t) => (
                <form
                  id={`t-${t.slug}`}
                  method="post"
                  action="/admin/pricing/therapist"
                >
                  <CsrfInput token={csrfToken} />
                  <input type="hidden" name="slug" value={t.slug} />
                </form>
              ))}
            </div>

            <Table>
              <Thead>
                <Tr>
                  <Th>Therapist</Th>
                  <Th>Role</Th>
                  <Th class="text-right">Full day ($)</Th>
                  <Th class="text-right">Half day ($)</Th>
                  <Th class="text-right">KAIR Full ($)</Th>
                  <Th class="text-right">KAIR Half ($)</Th>
                  <Th class="text-right">Payout %</Th>
                  <Th>Connect</Th>
                  <Th>Active</Th>
                  <Th></Th>
                </Tr>
              </Thead>
              <Tbody>
                {(rows as Row[]).map((t) => (
                  <Tr>
                    <Td class="font-medium whitespace-nowrap">{t.fullName}</Td>
                    <Td>
                      <Select
                        form={`t-${t.slug}`}
                        name="role"
                        class="w-72! inline-block"
                      >
                        {ROLES.map((r) => (
                          <option value={r} selected={r === t.role}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td class="text-right">
                      <Input
                        form={`t-${t.slug}`}
                        name="full_day_dollars"
                        type="number"
                        min="0"
                        step="1"
                        value={(t.fullDay / 100).toFixed(0)}
                        required
                        class="w-20 text-right inline-block"
                      />
                    </Td>
                    <Td class="text-right">
                      <Input
                        form={`t-${t.slug}`}
                        name="half_day_dollars"
                        type="number"
                        min="0"
                        step="1"
                        value={t.halfDay == null ? '' : (t.halfDay / 100).toFixed(0)}
                        placeholder="-"
                        class="w-20 text-right inline-block"
                      />
                    </Td>
                    <Td class="text-right">
                      <Input
                        form={`t-${t.slug}`}
                        name="kair_full_day_dollars"
                        type="number"
                        min="0"
                        step="1"
                        value={t.kairFullDay == null ? '' : (t.kairFullDay / 100).toFixed(0)}
                        placeholder="-"
                        class="w-20 text-right inline-block"
                      />
                    </Td>
                    <Td class="text-right">
                      <Input
                        form={`t-${t.slug}`}
                        name="kair_half_day_dollars"
                        type="number"
                        min="0"
                        step="1"
                        value={t.kairHalfDay == null ? '' : (t.kairHalfDay / 100).toFixed(0)}
                        placeholder="-"
                        class="w-20 text-right inline-block"
                      />
                    </Td>
                    <Td class="text-right">
                      <Input
                        form={`t-${t.slug}`}
                        name="payout_pct"
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={Number(t.payoutPct).toFixed(0)}
                        required
                        class="w-16 text-right inline-block"
                      />
                    </Td>
                    <Td>
                      {t.connectAccountId ? (
                        <code class="font-mono text-xs">
                          {t.connectAccountId.slice(0, 14)}…
                        </code>
                      ) : (
                        <span class="text-xs text-muted-foreground">none</span>
                      )}
                    </Td>
                    <Td>
                      {t.active ? (
                        <Badge variant="success">yes</Badge>
                      ) : (
                        <Badge variant="secondary">no</Badge>
                      )}
                    </Td>
                    <Td>
                      <Button
                        form={`t-${t.slug}`}
                        type="submit"
                        size="sm"
                        variant="outline"
                      >
                        Save
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>ACH discount</CardTitle>
            <CardDescription>
              Currently <span class="font-mono">{pctStr}%</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form method="post" action="/admin/pricing/ach-discount" class="flex items-end gap-3">
              <CsrfInput token={csrfToken} />
              <div class="space-y-2">
                <Label for="ach_discount_pct">ach_discount_pct (0–1, e.g. 0.030 = 3.0%)</Label>
                <Input
                  id="ach_discount_pct"
                  name="ach_discount_pct"
                  type="number"
                  step="0.0001"
                  min="0"
                  max="0.5"
                  value={ach.toFixed(4)}
                  required
                  class="w-40"
                />
              </div>
              <Button type="submit">Save</Button>
            </form>
          </CardContent>
        </Card>
      </AdminShell>
    </Layout>,
  );
});

adminPricingRoute.post('/therapist', async (c) => {
  // Admin-only - same gate as the rest of /admin/pricing.
  const user = c.get('user');
  if (user?.role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }

  const slug = String(form.get('slug') ?? '').trim();
  if (!slug) return c.json({ error: 'missing_slug' }, 400);

  const fullRaw = String(form.get('full_day_dollars') ?? '').trim();
  const halfRaw = String(form.get('half_day_dollars') ?? '').trim();

  const fullDollars = Number(fullRaw);
  if (!Number.isFinite(fullDollars) || fullDollars < 0 || fullDollars > 10_000) {
    return c.json({ error: 'invalid_full_day' }, 400);
  }
  const fullDayCents = Math.round(fullDollars * 100);

  let halfDayCents: number | null = null;
  if (halfRaw.length > 0) {
    const halfDollars = Number(halfRaw);
    if (!Number.isFinite(halfDollars) || halfDollars < 0 || halfDollars > 10_000) {
      return c.json({ error: 'invalid_half_day' }, 400);
    }
    halfDayCents = Math.round(halfDollars * 100);
  }

  const payoutPctRaw = String(form.get('payout_pct') ?? '').trim();
  const payoutPct = Number(payoutPctRaw);
  if (!Number.isFinite(payoutPct) || payoutPct < 0 || payoutPct > 100) {
    return c.json({ error: 'invalid_payout_pct' }, 400);
  }

  const roleRaw = String(form.get('role') ?? '').trim();
  if (!ROLES.includes(roleRaw as TherapistRole)) {
    return c.json({ error: 'invalid_role' }, 400);
  }
  const role = roleRaw as TherapistRole;

  const parseOptionalDollars = (
    raw: string,
    field: 'kair_full_day' | 'kair_half_day',
  ): { ok: true; cents: number | null } | { ok: false; error: string } => {
    if (raw.length === 0) return { ok: true, cents: null };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 10_000) {
      return { ok: false, error: `invalid_${field}` };
    }
    return { ok: true, cents: Math.round(n * 100) };
  };

  const kairFullRes = parseOptionalDollars(
    String(form.get('kair_full_day_dollars') ?? '').trim(),
    'kair_full_day',
  );
  if (!kairFullRes.ok) return c.json({ error: kairFullRes.error }, 400);
  const kairHalfRes = parseOptionalDollars(
    String(form.get('kair_half_day_dollars') ?? '').trim(),
    'kair_half_day',
  );
  if (!kairHalfRes.ok) return c.json({ error: kairHalfRes.error }, 400);

  // KAIR-eligible iff both KAIR rates are populated. Server-side mirrors
  // the runtime invariant in the v0.23.0 schema comment.
  const kairEligible =
    kairFullRes.cents !== null && kairHalfRes.cents !== null;

  const { db } = await getDb();
  const result = await db
    .update(therapists)
    .set({
      role,
      defaultFullDayCents: fullDayCents,
      defaultHalfDayCents: halfDayCents,
      kairEligible,
      kairFullDayCents: kairFullRes.cents,
      kairHalfDayCents: kairHalfRes.cents,
      therapistPayoutPct: payoutPct.toFixed(2),
    })
    .where(eq(therapists.slug, slug))
    .returning({ id: therapists.id });

  if (result.length === 0) {
    return c.json({ error: 'therapist_not_found' }, 404);
  }

  log.info('therapist_rates_updated', {
    slug,
    role,
    fullDayCents,
    halfDayCents,
    kairFullDayCents: kairFullRes.cents,
    kairHalfDayCents: kairHalfRes.cents,
    kairEligible,
    payoutPct,
    updatedByEmail: user.email ?? null,
  });

  return c.redirect('/admin/pricing');
});

adminPricingRoute.post('/ach-discount', async (c) => {
  // P2#16: only admins edit global pricing config.
  const user = c.get('user');
  if (user?.role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
  const raw = form.get('ach_discount_pct');
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 0.5) {
    return c.json({ error: 'invalid_pct' }, 400);
  }

  const { db } = await getDb();
  await db
    .insert(pricingConfig)
    .values({ id: 'singleton', achDiscountPct: pct.toFixed(4) })
    .onConflictDoUpdate({
      target: pricingConfig.id,
      set: { achDiscountPct: pct.toFixed(4), updatedAt: new Date() },
    });

  log.info('pricing_config_updated', { ach_discount_pct: pct });
  return c.redirect('/admin/pricing');
});
