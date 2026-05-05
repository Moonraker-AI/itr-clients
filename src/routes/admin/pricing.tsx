/**
 * /admin/pricing — read existing per-therapist rates + edit ach_discount_pct.
 *
 * Auth: gated behind the M8 requireAuth middleware. CSRF protected via
 * the double-submit cookie + hidden input pattern (lib/csrf.ts).
 */

import { Hono } from 'hono';
import { eq, asc } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { pricingConfig, therapists, locations } from '../../db/schema.js';
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
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '../../lib/ui/index.js';

export const adminPricingRoute = new Hono();

type Row = {
  slug: string;
  fullName: string;
  role: string;
  fullDay: number;
  halfDay: number | null;
  active: boolean;
  locationName: string | null;
};

adminPricingRoute.get('/', async (c) => {
  const { db } = await getDb();

  const rows = await db
    .select({
      slug: therapists.slug,
      fullName: therapists.fullName,
      role: therapists.role,
      fullDay: therapists.defaultFullDayCents,
      halfDay: therapists.defaultHalfDayCents,
      active: therapists.active,
      locationName: locations.name,
    })
    .from(therapists)
    .leftJoin(locations, eq(therapists.primaryLocationId, locations.id))
    .orderBy(asc(therapists.fullName));

  const [config] = await db
    .select()
    .from(pricingConfig)
    .where(eq(pricingConfig.id, 'singleton'));

  const ach = config ? Number(config.achDiscountPct) : 0.03;
  const csrfToken = ensureCsrfToken(c);
  const user = c.get('user');
  const pctStr = (ach * 100).toFixed(2);

  return c.html(
    <Layout title="Pricing — ITR Client HQ">
      <AdminShell user={user} current="pricing">
        <PageHeader title="Pricing" description="Per-therapist rates and ACH discount config." />

        <Card class="mb-6">
          <CardHeader>
            <CardTitle>Per-therapist rates</CardTitle>
            <CardDescription>
              Authoritatively set by the seed script (DESIGN.md §4). Rate changes go through code review.
            </CardDescription>
          </CardHeader>
          <CardContent class="px-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>Therapist</Th>
                  <Th>Role</Th>
                  <Th>Location</Th>
                  <Th class="text-right">Full day</Th>
                  <Th class="text-right">Half day</Th>
                  <Th>Active</Th>
                </Tr>
              </Thead>
              <Tbody>
                {(rows as Row[]).map((t) => (
                  <Tr>
                    <Td class="font-medium">{t.fullName}</Td>
                    <Td class="text-muted-foreground text-sm">{t.role}</Td>
                    <Td class="text-sm">{t.locationName ?? '—'}</Td>
                    <Td class="text-right">{formatCents(t.fullDay)}</Td>
                    <Td class="text-right">{t.halfDay == null ? '—' : formatCents(t.halfDay)}</Td>
                    <Td>
                      {t.active ? (
                        <Badge variant="success">yes</Badge>
                      ) : (
                        <Badge variant="secondary">no</Badge>
                      )}
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

adminPricingRoute.post('/ach-discount', async (c) => {
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
