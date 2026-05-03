/**
 * /admin/clients/:id/complete — therapist completion form (M5).
 *
 *   GET   render form with planned vs actual day inputs.
 *   POST  call `transitions.submitCompletion`, attempt the off-session
 *         final charge, dispatch to `markCompleted` or
 *         `markFinalChargeFailed` based on result, redirect to detail.
 *
 * The synchronous handler-side attempt is authoritative for the immediate
 * transition; the Stripe webhook is wired (M5) as a redundant ack.
 */

import { Hono } from 'hono';
import { and, eq, sum } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  clients,
  payments,
  retreats,
  stripeCustomers,
} from '../../db/schema.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';
import { chargeFinalBalance } from '../../lib/stripe.js';
import { formatCents } from '../../lib/pricing.js';

export const adminCompleteRoute = new Hono();

adminCompleteRoute.get('/:id/complete', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();

  const [row] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      plannedFullDays: retreats.plannedFullDays,
      plannedHalfDays: retreats.plannedHalfDays,
      actualFullDays: retreats.actualFullDays,
      actualHalfDays: retreats.actualHalfDays,
      fullDayRateCents: retreats.fullDayRateCents,
      halfDayRateCents: retreats.halfDayRateCents,
      depositCents: retreats.depositCents,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .where(eq(retreats.id, id));
  if (!row) return c.notFound();

  const error = c.req.query('error');

  return c.html(
    renderForm({
      retreatId: row.retreatId,
      state: row.state,
      plannedFullDays: row.plannedFullDays,
      plannedHalfDays: row.plannedHalfDays,
      actualFullDays: row.actualFullDays,
      actualHalfDays: row.actualHalfDays,
      fullDayRateCents: row.fullDayRateCents,
      halfDayRateCents: row.halfDayRateCents,
      depositCents: row.depositCents,
      clientName: `${row.clientFirstName} ${row.clientLastName}`,
      error: error ?? null,
    }),
  );
});

adminCompleteRoute.post('/:id/complete', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.formData();
  const actualFullDays = Number(form.get('actual_full_days') ?? 0);
  const actualHalfDays = Number(form.get('actual_half_days') ?? 0);

  if (
    !Number.isInteger(actualFullDays) ||
    !Number.isInteger(actualHalfDays) ||
    actualFullDays < 0 ||
    actualHalfDays < 0 ||
    actualFullDays + actualHalfDays === 0
  ) {
    return c.redirect(`/admin/clients/${id}/complete?error=invalid_day_counts`);
  }

  try {
    await transitions.submitCompletion({
      retreatId: id,
      actor: { kind: 'system' },
      actualFullDays,
      actualHalfDays,
    });
  } catch (err) {
    log.warn('admin_submit_completion_failed', {
      retreatId: id,
      error: (err as Error).message,
    });
    const code = encodeURIComponent((err as Error).message).slice(0, 200);
    return c.redirect(`/admin/clients/${id}/complete?error=${code}`);
  }

  const { db } = await getDb();
  const [r] = await db
    .select({
      retreatId: retreats.id,
      clientId: retreats.clientId,
      totalActualCents: retreats.totalActualCents,
    })
    .from(retreats)
    .where(eq(retreats.id, id));
  if (!r || r.totalActualCents == null) {
    log.error('admin_complete_missing_total_actual', { retreatId: id });
    return c.redirect(`/admin/clients/${id}/complete?error=internal`);
  }

  const [sc] = await db
    .select({
      stripeCustomerId: stripeCustomers.stripeCustomerId,
      defaultPaymentMethodId: stripeCustomers.defaultPaymentMethodId,
    })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.clientId, r.clientId));

  // Balance = total actual - sum of succeeded deposits.
  const [paid] = await db
    .select({ total: sum(payments.amountCents) })
    .from(payments)
    .where(
      and(
        eq(payments.retreatId, id),
        eq(payments.kind, 'deposit'),
        eq(payments.status, 'succeeded'),
      ),
    );
  const depositPaid = Number(paid?.total ?? 0);
  const balance = r.totalActualCents - depositPaid;

  if (balance <= 0) {
    // No balance owed (deposit covered everything). Mark completed with
    // a synthetic zero-amount payments row keyed on a deterministic id so
    // the webhook dispatch path doesn't double-write.
    await transitions.markCompleted({
      retreatId: id,
      actor: { kind: 'system' },
      stripePaymentIntentId: `final_zero_${id}`,
      amountCents: 0,
    });
    return c.redirect(`/admin/clients/${id}`);
  }

  if (!sc || !sc.defaultPaymentMethodId) {
    log.warn('admin_complete_no_saved_pm', { retreatId: id });
    await transitions.markFinalChargeFailed({
      retreatId: id,
      actor: { kind: 'system' },
      failureCode: 'no_saved_payment_method',
      failureMessage:
        'no saved payment method on stripe_customers — cannot off-session charge',
    });
    return c.redirect(`/admin/clients/${id}`);
  }

  const charge = await chargeFinalBalance({
    retreatId: id,
    clientId: r.clientId,
    stripeCustomerId: sc.stripeCustomerId,
    paymentMethodId: sc.defaultPaymentMethodId,
    amountCents: balance,
    idempotencyKey: `final:${id}:1`,
  });

  if (charge.status === 'succeeded') {
    await transitions.markCompleted({
      retreatId: id,
      actor: { kind: 'system' },
      stripePaymentIntentId: charge.paymentIntentId,
      ...(charge.chargeId ? { stripeChargeId: charge.chargeId } : {}),
      amountCents: balance,
    });
  } else {
    await transitions.markFinalChargeFailed({
      retreatId: id,
      actor: { kind: 'system' },
      failureCode: charge.failureCode ?? 'unknown',
      failureMessage: charge.failureMessage ?? '',
      ...(charge.paymentIntentId
        ? { stripePaymentIntentId: charge.paymentIntentId }
        : {}),
      amountCents: balance,
      ...(charge.clientSecret ? { clientSecret: charge.clientSecret } : {}),
    });
  }

  return c.redirect(`/admin/clients/${id}`);
});

interface FormArgs {
  retreatId: string;
  state: string;
  plannedFullDays: number;
  plannedHalfDays: number;
  actualFullDays: number | null;
  actualHalfDays: number | null;
  fullDayRateCents: number;
  halfDayRateCents: number | null;
  depositCents: number;
  clientName: string;
  error: string | null;
}

function renderForm(args: FormArgs): string {
  const stateBlock =
    args.state !== 'in_progress'
      ? `<p style="color:#a00"><strong>State is <code>${escHtml(args.state)}</code></strong> — only <code>in_progress</code> can submit completion.</p>`
      : '';
  const errBlock = args.error
    ? `<p style="color:#a00"><strong>Error:</strong> ${escHtml(decodeURIComponent(args.error))}</p>`
    : '';
  const fullVal = args.actualFullDays ?? args.plannedFullDays;
  const halfVal = args.actualHalfDays ?? args.plannedHalfDays;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Complete retreat — ITR Client HQ</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-weight: 600; }
    label { display: block; margin-bottom: 0.6rem; }
    label span { display: inline-block; width: 200px; }
    input[type=number] { padding: 0.4rem; font: inherit; width: 100px; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    .meta { color: #666; }
  </style>
</head>
<body>
  <h1>Complete retreat</h1>
  <p class="meta">Retreat <code>${escHtml(args.retreatId)}</code> · ${escHtml(args.clientName)}</p>
  <p class="meta">
    Planned: ${args.plannedFullDays} full + ${args.plannedHalfDays} half ·
    Rates: ${formatCents(args.fullDayRateCents)} full ${args.halfDayRateCents == null ? '' : `/ ${formatCents(args.halfDayRateCents)} half`} ·
    Deposit paid: ${formatCents(args.depositCents)}
  </p>
  <p class="meta">Submitting will (1) lock actual day counts, (2) attempt the off-session final charge against the saved payment method, (3) flip state to <code>completed</code> on success or <code>final_charge_failed</code> on failure.</p>
  ${stateBlock}
  ${errBlock}
  <form method="post">
    <label><span>Actual full days</span><input type="number" name="actual_full_days" min="0" step="1" value="${fullVal}" required></label>
    <label><span>Actual half days</span><input type="number" name="actual_half_days" min="0" step="1" value="${halfVal}" required></label>
    <button type="submit">Submit + charge balance</button>
  </form>
  <p><a href="/admin/clients/${escAttr(args.retreatId)}">← back to detail</a></p>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escAttr(s: string): string {
  return escHtml(s).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
