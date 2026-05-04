/**
 * /admin/clients/:id/refund — partial or full refund of a prior payment (M7).
 *
 *   GET   list refundable payments + form (target PI, amount, reason)
 *   POST  call stripe.refundPayment, write payments(kind='refund') row +
 *         audit_event 'refunded', redirect to detail.
 *
 * Refund does NOT change retreat state — it's orthogonal to the state
 * machine. The completed/cancelled/etc. state stays as-is; the
 * payments table grows a new row.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  auditEvents,
  clients,
  payments,
  retreats,
} from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import {
  csrfInputHtml,
  ensureCsrfToken,
  verifyCsrfToken,
} from '../../lib/csrf.js';
import { log } from '../../lib/phi-redactor.js';
import { formatCents } from '../../lib/pricing.js';
import { refundPayment } from '../../lib/stripe.js';

export const adminRefundRoute = new Hono();

adminRefundRoute.get('/:id/refund', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();

  const [r] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      therapistId: retreats.therapistId,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .where(eq(retreats.id, id));
  if (!r) return c.notFound();
  if (!therapistCanAccess(c.get('user'), r.therapistId)) return c.notFound();

  const refundable = await db
    .select({
      id: payments.id,
      kind: payments.kind,
      amountCents: payments.amountCents,
      status: payments.status,
      stripePaymentIntentId: payments.stripePaymentIntentId,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(eq(payments.retreatId, id), eq(payments.status, 'succeeded')));

  const error = c.req.query('error');
  const csrfHtml = csrfInputHtml(ensureCsrfToken(c));

  return c.html(
    renderForm({
      retreatId: r.retreatId,
      state: r.state,
      clientName: `${r.clientFirstName} ${r.clientLastName}`,
      refundable,
      error: error ?? null,
      csrfHtml,
    }),
  );
});

adminRefundRoute.post('/:id/refund', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
  const paymentId = String(form.get('payment_id') ?? '').trim();
  const amountDollarsRaw = String(form.get('amount_dollars') ?? '').trim();
  const reasonNote = String(form.get('reason_note') ?? '').trim();

  if (!paymentId) {
    return c.redirect(`/admin/clients/${id}/refund?error=missing_payment`);
  }

  const { db } = await getDb();
  const [retreat] = await db
    .select({
      retreatId: retreats.id,
      clientId: retreats.clientId,
      therapistId: retreats.therapistId,
    })
    .from(retreats)
    .where(eq(retreats.id, id));
  if (!retreat) return c.notFound();
  if (!therapistCanAccess(c.get('user'), retreat.therapistId)) return c.notFound();

  const [target] = await db
    .select({
      id: payments.id,
      stripePaymentIntentId: payments.stripePaymentIntentId,
      amountCents: payments.amountCents,
      kind: payments.kind,
      status: payments.status,
    })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.retreatId, id)));
  if (!target) {
    return c.redirect(`/admin/clients/${id}/refund?error=payment_not_found`);
  }
  if (target.status !== 'succeeded') {
    return c.redirect(`/admin/clients/${id}/refund?error=payment_not_refundable`);
  }
  if (!target.stripePaymentIntentId || target.stripePaymentIntentId.startsWith('final_zero_')) {
    return c.redirect(`/admin/clients/${id}/refund?error=payment_has_no_stripe_charge`);
  }

  let amountCents: number | null = null;
  if (amountDollarsRaw.length > 0) {
    const dollars = Number(amountDollarsRaw);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      return c.redirect(`/admin/clients/${id}/refund?error=invalid_amount`);
    }
    amountCents = Math.round(dollars * 100);
    if (amountCents > target.amountCents) {
      return c.redirect(`/admin/clients/${id}/refund?error=amount_exceeds_payment`);
    }
  }

  // Count prior refunds against this same PI for the idempotency key.
  const priorRefunds = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.retreatId, id),
        eq(payments.kind, 'refund'),
        eq(payments.stripePaymentIntentId, target.stripePaymentIntentId),
      ),
    );
  const refundAttempt = priorRefunds.length + 1;

  let res;
  try {
    res = await refundPayment({
      paymentIntentId: target.stripePaymentIntentId,
      amountCents,
      idempotencyKey: `refund:${target.stripePaymentIntentId}:${refundAttempt}`,
      retreatId: id,
      clientId: retreat.clientId,
    });
  } catch (err) {
    log.error('admin_refund_stripe_error', {
      retreatId: id,
      error: (err as Error).message,
    });
    const code = encodeURIComponent((err as Error).message).slice(0, 200);
    return c.redirect(`/admin/clients/${id}/refund?error=${code}`);
  }

  // Persist a payments(kind='refund') row + audit event. Refund row keys
  // on the refundId via stripe_charge_id — we don't have a separate refund
  // unique index, so reuse stripe_charge_id text column.
  await db.transaction(async (tx) => {
    await tx.insert(payments).values({
      retreatId: id,
      kind: 'refund',
      stripePaymentIntentId: target.stripePaymentIntentId,
      stripeChargeId: res.refundId,
      amountCents: -res.amountCents,
      status: 'succeeded',
      failureMessage: reasonNote ? reasonNote.slice(0, 200) : null,
      attemptCount: refundAttempt,
      lastAttemptedAt: new Date(),
    });
    await tx.insert(auditEvents).values({
      retreatId: id,
      actorType: 'system',
      actorId: null,
      eventType: 'refunded',
      payload: {
        stripe_payment_intent_id: target.stripePaymentIntentId,
        refund_id: res.refundId,
        amount_cents: res.amountCents,
        full_refund: amountCents == null,
        reason_note: reasonNote ? reasonNote.slice(0, 200) : null,
        refund_attempt: refundAttempt,
      },
    });
  });

  log.info('admin_refund_recorded', {
    retreatId: id,
    refundId: res.refundId,
    amount_cents: res.amountCents,
    dryRun: res.dryRun,
  });

  return c.redirect(`/admin/clients/${id}`);
});

interface FormArgs {
  retreatId: string;
  state: string;
  clientName: string;
  refundable: Array<{
    id: string;
    kind: 'deposit' | 'final' | 'refund';
    amountCents: number;
    status: string;
    stripePaymentIntentId: string | null;
    createdAt: Date;
  }>;
  error: string | null;
  csrfHtml: string;
}

function renderForm(args: FormArgs): string {
  const refundOptions = args.refundable
    .filter((p) => p.kind !== 'refund')
    .map(
      (p) =>
        `<option value="${escAttr(p.id)}">${escHtml(p.kind)} · ${formatCents(p.amountCents)} · ${escHtml(p.stripePaymentIntentId ?? 'no-PI')} · ${escHtml(p.createdAt.toISOString())}</option>`,
    )
    .join('');

  const errBlock = args.error
    ? `<p style="color:#a00"><strong>Error:</strong> ${escHtml(decodeURIComponent(args.error))}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Refund — ITR Client HQ</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-weight: 600; }
    label { display: block; margin-bottom: 0.6rem; }
    label span { display: inline-block; width: 200px; }
    select, input, textarea { padding: 0.4rem; font: inherit; }
    select, input[type=text], input[type=number], textarea { width: 420px; }
    textarea { vertical-align: top; height: 4rem; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    .meta { color: #666; }
  </style>
</head>
<body>
  <h1>Refund</h1>
  <p class="meta">Retreat <code>${escHtml(args.retreatId)}</code> · ${escHtml(args.clientName)} · state <code>${escHtml(args.state)}</code></p>
  <p class="meta">Refunding does NOT change retreat state. It writes a refund row to the payments table and a 'refunded' audit event. Stripe processes the refund against the original PaymentIntent.</p>
  ${errBlock}
  <form method="post">
    ${args.csrfHtml}
    <label>
      <span>Target payment</span>
      <select name="payment_id" required>
        <option value="">Select…</option>
        ${refundOptions}
      </select>
    </label>
    <label><span>Amount ($)</span><input type="number" name="amount_dollars" min="0.01" step="0.01" placeholder="leave blank for full refund"></label>
    <label><span>Reason note</span><textarea name="reason_note" placeholder="Internal — never sent to Stripe metadata. Free-text up to 200 chars."></textarea></label>
    <button type="submit">Submit refund</button>
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
