/**
 * /admin/pricing — read existing per-therapist rates + edit ach_discount_pct.
 *
 * Auth: gated behind the M8 requireAuth middleware. CSRF protected via
 * the double-submit cookie + hidden input pattern (lib/csrf.ts). Plain
 * server-rendered HTML.
 */

import { Hono } from 'hono';
import { eq, asc } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { pricingConfig, therapists, locations } from '../../db/schema.js';
import {
  csrfInputHtml,
  ensureCsrfToken,
  verifyCsrfToken,
} from '../../lib/csrf.js';
import { formatCents } from '../../lib/pricing.js';
import { log } from '../../lib/phi-redactor.js';

export const adminPricingRoute = new Hono();

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
  const csrfHtml = csrfInputHtml(ensureCsrfToken(c));

  return c.html(
    renderPricingPage({ therapists: rows, achDiscountPct: ach, csrfHtml }),
  );
});

adminPricingRoute.post('/ach-discount', async (c) => {
  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
  const raw = form.get('ach_discount_pct');
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct >= 1) {
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

type Row = {
  slug: string;
  fullName: string;
  role: string;
  fullDay: number;
  halfDay: number | null;
  active: boolean;
  locationName: string | null;
};

function renderPricingPage(args: {
  therapists: Row[];
  achDiscountPct: number;
  csrfHtml: string;
}): string {
  const rows = args.therapists
    .map(
      (t) => `
      <tr>
        <td>${escape(t.fullName)}</td>
        <td>${escape(t.role)}</td>
        <td>${escape(t.locationName ?? '—')}</td>
        <td style="text-align:right">${formatCents(t.fullDay)}</td>
        <td style="text-align:right">${
          t.halfDay == null ? '—' : formatCents(t.halfDay)
        }</td>
        <td>${t.active ? 'yes' : 'no'}</td>
      </tr>`,
    )
    .join('');

  const pctStr = (args.achDiscountPct * 100).toFixed(2);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Pricing — ITR Client HQ</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    h1, h2 { font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
    th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; text-align: left; }
    th { font-weight: 600; background: #f6f6f6; }
    form { display: flex; gap: 0.5rem; align-items: center; }
    input[type=number] { padding: 0.3rem; width: 6rem; }
    button { padding: 0.4rem 0.8rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Pricing</h1>
  <h2>Per-therapist rates (ACH-published)</h2>
  <table>
    <thead><tr>
      <th>Therapist</th><th>Role</th><th>Location</th>
      <th style="text-align:right">Full day</th><th style="text-align:right">Half day</th><th>Active</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p>Per-therapist rates are authoritatively set by the seed script
  (see DESIGN.md §4). Inline edit is intentionally not surfaced here —
  rate changes go through a code review.</p>

  <h2>ACH discount</h2>
  <form method="post" action="/admin/pricing/ach-discount">
    ${args.csrfHtml}
    <label for="ach_discount_pct">ach_discount_pct (0–1, e.g. 0.030 = 3.0%)</label>
    <input id="ach_discount_pct" name="ach_discount_pct" type="number"
      step="0.0001" min="0" max="0.5" value="${escape(
        args.achDiscountPct.toFixed(4),
      )}" required>
    <button type="submit">Save</button>
    <span style="color:#666">current: ${pctStr}%</span>
  </form>
</body>
</html>`;
}

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
