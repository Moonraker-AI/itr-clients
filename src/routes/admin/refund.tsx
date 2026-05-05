/**
 * /admin/clients/:id/refund — partial or full refund of a prior payment (M7).
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { auditEvents, clients, payments, retreats } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { ensureCsrfToken, verifyCsrfToken } from '../../lib/csrf.js';
import { log } from '../../lib/phi-redactor.js';
import { formatCents } from '../../lib/pricing.js';
import { refundPayment } from '../../lib/stripe.js';
import {
  AdminShell,
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CsrfInput,
  Field,
  Input,
  Layout,
  LinkButton,
  PageHeader,
  Select,
  Textarea,
} from '../../lib/ui/index.js';

export const adminRefundRoute = new Hono();

const PHI_EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHI_PHONE_RE = /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const PHI_DOB_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
function hasPhiShape(s: string): boolean {
  return PHI_EMAIL_RE.test(s) || PHI_PHONE_RE.test(s) || PHI_DOB_RE.test(s);
}

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
  const csrfToken = ensureCsrfToken(c);
  const user = c.get('user');
  const clientName = `${r.clientFirstName} ${r.clientLastName}`;
  const filtered = refundable.filter((p) => p.kind !== 'refund');

  return c.html(
    <Layout title="Refund — ITR Clients">
      <AdminShell user={user} current="dashboard">
        <PageHeader title="Refund" description={`${clientName} · ${id.slice(0, 8)}`}>
          <Badge variant="secondary">{r.state}</Badge>
          <LinkButton href={`/admin/clients/${id}`} variant="ghost" size="sm">
            ← back
          </LinkButton>
        </PageHeader>

        <div class="max-w-2xl space-y-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{decodeURIComponent(error)}</AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Refund a payment</CardTitle>
              <CardDescription>
                Refunding does NOT change retreat state. Writes a refund row + 'refunded' audit event.
                Stripe processes the refund against the original PaymentIntent.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form method="post" class="space-y-4">
                <CsrfInput token={csrfToken} />
                <Field label="Target payment" for="payment_id">
                  <Select id="payment_id" name="payment_id" required>
                    <option value="">Select…</option>
                    {filtered.map((p) => (
                      <option value={p.id}>
                        {p.kind} · {formatCents(p.amountCents)} ·{' '}
                        {p.stripePaymentIntentId ?? 'no-PI'} · {p.createdAt.toISOString()}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Amount ($)" for="amount_dollars" hint="Leave blank for full refund">
                  <Input
                    id="amount_dollars"
                    name="amount_dollars"
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="leave blank for full refund"
                  />
                </Field>
                <Field
                  label="Reason note"
                  for="reason_note"
                  hint="Internal — never sent to Stripe metadata. ≤200 chars."
                >
                  <Textarea
                    id="reason_note"
                    name="reason_note"
                    rows={3}
                    placeholder="Internal note."
                  />
                </Field>
                <Button type="submit">Submit refund</Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </AdminShell>
    </Layout>,
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
  if (reasonNote.length > 200) {
    return c.redirect(`/admin/clients/${id}/refund?error=reason_note_too_long`);
  }
  if (reasonNote && hasPhiShape(reasonNote)) {
    return c.redirect(`/admin/clients/${id}/refund?error=reason_note_contains_phi`);
  }

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

  await db.transaction(async (tx) => {
    await tx.insert(payments).values({
      retreatId: id,
      kind: 'refund',
      stripePaymentIntentId: target.stripePaymentIntentId,
      stripeChargeId: res.refundId,
      amountCents: -res.amountCents,
      status: 'succeeded',
      failureMessage: reasonNote || null,
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
        reason_note: reasonNote || null,
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
