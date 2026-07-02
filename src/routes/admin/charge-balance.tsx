/**
 * /admin/clients/:id/charge-balance - MANUAL final-balance charge (v0.29.x).
 *
 * Decoupled from the day-count completion flow (complete.tsx): the admin types
 * the exact dollar amount to charge against the client's saved card/bank, with
 * NO automatic math. Available as soon as a deposit is recorded (the saved
 * payment method exists). On success the retreat is marked completed; on
 * failure it lands in final_charge_failed (and the existing retry/recovery
 * machinery takes over, since beginFinalCharge stamps total_actual_cents).
 * ACH bank debits confirm with PI status `processing` and settle days
 * later: those park in awaiting_final_charge with a `pending` payments row
 * (blocking further manual charges) until the Stripe webhook settles them.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  clients,
  payments,
  retreats,
  stripeCustomers,
  therapists,
} from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { ensureCsrfToken, verifyCsrfToken } from '../../lib/csrf.js';
import { log } from '../../lib/phi-redactor.js';
import { formatCents } from '../../lib/pricing.js';
import {
  retreatStatusLabel,
  transitions,
  withRetreatChargeLock,
} from '../../lib/state-machine.js';
import { chargeFinalBalance } from '../../lib/stripe.js';
import {
  AdminShell,
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CsrfInput,
  Field,
  Input,
  Layout,
  LinkButton,
  PageHeader,
} from '../../lib/ui/index.js';

export const adminChargeBalanceRoute = new Hono();

const TERMINAL = new Set(['completed', 'cancelled']);

async function loadCtx(id: string) {
  const { db } = await getDb();
  const [row] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      clientId: retreats.clientId,
      therapistId: retreats.therapistId,
      depositCents: retreats.depositCents,
      totalPlannedCents: retreats.totalPlannedCents,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .where(eq(retreats.id, id));
  if (!row) return null;

  const depRows = await db
    .select({ amountCents: payments.amountCents })
    .from(payments)
    .where(
      and(
        eq(payments.retreatId, id),
        eq(payments.kind, 'deposit'),
        eq(payments.status, 'succeeded'),
      ),
    );
  const depositPaidCents = depRows.reduce((acc, p) => acc + p.amountCents, 0);

  // An in-flight delayed-settlement debit (ACH: payments row `pending`)
  // means the client's bank is already being drafted. Charging again now
  // would double-debit, so the form is locked until the webhook settles it.
  const [pendingFinal] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.retreatId, id),
        eq(payments.kind, 'final'),
        eq(payments.status, 'pending'),
      ),
    )
    .limit(1);

  return { row, depositPaidCents, hasPendingFinal: Boolean(pendingFinal) };
}

adminChargeBalanceRoute.get('/:id/charge-balance', async (c) => {
  const id = c.req.param('id');
  const ctx = await loadCtx(id);
  if (!ctx) return c.notFound();
  if (!therapistCanAccess(c.get('user'), ctx.row.therapistId)) return c.notFound();

  const error = c.req.query('error');
  const csrfToken = ensureCsrfToken(c);
  const user = c.get('user');
  const clientName = `${ctx.row.clientFirstName} ${ctx.row.clientLastName}`;
  const chargeable =
    ctx.depositPaidCents > 0 && !TERMINAL.has(ctx.row.state) && !ctx.hasPendingFinal;

  return c.html(
    <Layout title="Charge final balance - ITR Clients">
      <AdminShell user={user} current="dashboard">
        <PageHeader title="Charge final balance" description={`${clientName} · ${id.slice(0, 8)}`}>
          <LinkButton href={`/admin/clients/${id}`} variant="ghost" size="sm">
            ← back
          </LinkButton>
        </PageHeader>

        <div class="max-w-2xl space-y-4">
          {!chargeable ? (
            <Alert variant="destructive">
              <AlertTitle>Not chargeable</AlertTitle>
              <AlertDescription>
                {ctx.depositPaidCents === 0
                  ? 'No deposit has been recorded yet, so there is no saved payment method to charge.'
                  : ctx.hasPendingFinal
                    ? 'A bank debit for this retreat is still processing at Stripe (ACH takes a few business days to settle). Charging again now would debit the client twice. This page unlocks automatically once Stripe reports the debit as paid or failed.'
                    : `Status is ${retreatStatusLabel(ctx.row.state)}; this retreat cannot be charged.`}
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{decodeURIComponent(error)}</AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>For reference</CardTitle>
            </CardHeader>
            <CardContent class="text-sm text-muted-foreground space-y-1">
              <div>Deposit already paid: <strong>{formatCents(ctx.depositPaidCents)}</strong></div>
              {ctx.row.totalPlannedCents != null ? (
                <div>Total planned (estimate): {formatCents(ctx.row.totalPlannedCents)}</div>
              ) : null}
              <div class="pt-2">
                Enter the exact amount to charge now. Nothing is calculated for you, the
                deposit is not subtracted automatically.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Charge the saved card / bank</CardTitle>
            </CardHeader>
            <CardContent>
              <form method="post" class="space-y-4">
                <CsrfInput token={csrfToken} />
                <Field label="Amount to charge (USD)" for="amount">
                  <Input
                    id="amount"
                    name="amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    inputmode="decimal"
                    placeholder="0.00"
                    required
                    disabled={!chargeable}
                  />
                </Field>
                <Button type="submit" size="lg" disabled={!chargeable}>
                  Charge now
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </AdminShell>
    </Layout>,
  );
});

adminChargeBalanceRoute.post('/:id/charge-balance', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();
  const [owner] = await db
    .select({ therapistId: retreats.therapistId, clientId: retreats.clientId, state: retreats.state })
    .from(retreats)
    .where(eq(retreats.id, id));
  if (!owner) return c.notFound();
  if (!therapistCanAccess(c.get('user'), owner.therapistId)) return c.notFound();

  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }

  const dollars = Number(form.get('amount'));
  const amountCents = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || dollars <= 0 || !Number.isInteger(amountCents) || amountCents <= 0) {
    return c.redirect(`/admin/clients/${id}/charge-balance?error=${encodeURIComponent('Enter a valid dollar amount.')}`);
  }
  if (TERMINAL.has(owner.state)) {
    return c.redirect(`/admin/clients/${id}/charge-balance?error=${encodeURIComponent('Retreat is already completed or cancelled.')}`);
  }

  // Saved payment method must exist (it is captured at deposit time).
  const [sc] = await db
    .select({
      stripeCustomerId: stripeCustomers.stripeCustomerId,
      defaultPaymentMethodId: stripeCustomers.defaultPaymentMethodId,
    })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.clientId, owner.clientId));
  if (!sc || !sc.defaultPaymentMethodId) {
    return c.redirect(`/admin/clients/${id}/charge-balance?error=${encodeURIComponent('No saved payment method on file. A paid deposit captures it.')}`);
  }
  // Capture the narrowed value; the null-guard above doesn't flow into the
  // lock closure below.
  const paymentMethodId = sc.defaultPaymentMethodId;

  // Serialize with the retry cron (and any concurrent admin submit) via the
  // same per-retreat advisory lock retryFailedCharge takes. Without it a
  // cron retry mid-flight could race this charge between its state read and
  // its Stripe call.
  const locked = await withRetreatChargeLock(id, async () => {
    // DOUBLE-CHARGE GUARD: a pending final-kind payments row means a
    // delayed-settlement debit (ACH) is already in flight at Stripe.
    // Checked inside the lock so a webhook settling it can't race us.
    const [pendingRow] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(eq(payments.retreatId, id), eq(payments.kind, 'final'), eq(payments.status, 'pending')),
      )
      .limit(1);
    if (pendingRow) {
      log.info('admin_charge_balance_blocked_pending_debit', { retreatId: id });
      return c.redirect(
        `/admin/clients/${id}/charge-balance?error=${encodeURIComponent('A bank debit for this retreat is still processing at Stripe. Charging again would debit the client twice. Wait for the pending debit to settle.')}`,
      );
    }

    // Move into awaiting_final_charge (stamps total_actual_cents = deposit +
    // this amount, so the retry/recovery machinery resolves to exactly this).
    try {
      await transitions.beginFinalCharge({
        retreatId: id,
        actor: { kind: 'system' },
        chargeAmountCents: amountCents,
      });
    } catch (err) {
      log.warn('admin_charge_balance_begin_failed', { retreatId: id, error: (err as Error).message });
      return c.redirect(`/admin/clients/${id}/charge-balance?error=${encodeURIComponent((err as Error).message).slice(0, 200)}`);
    }

    // Idempotency: stable per attempt so an accidental double-submit dedupes at
    // Stripe, while a deliberate later charge gets a fresh key.
    const finalRows = await db
      .select({ id: payments.id, status: payments.status })
      .from(payments)
      .where(and(eq(payments.retreatId, id), eq(payments.kind, 'final')));
    const attempt = finalRows.length + 1;
    // Failure-count numbering (cron-aligned: succeeded rows don't count).
    // Drives the retry-exhausted escalation when this failure is the third.
    const failedAttempt =
      finalRows.filter((p) => p.status !== 'succeeded').length + 1;

    const [t] = await db
      .select({
        connectAccountId: therapists.stripeConnectAccountId,
        payoutPct: therapists.therapistPayoutPct,
      })
      .from(therapists)
      .where(eq(therapists.id, owner.therapistId));

    const charge = await chargeFinalBalance({
      retreatId: id,
      clientId: owner.clientId,
      stripeCustomerId: sc.stripeCustomerId,
      paymentMethodId,
      amountCents,
      idempotencyKey: `final:${id}:${attempt}`,
      connectAccountId: t?.connectAccountId ?? null,
      payoutPct: t?.payoutPct ?? null,
    });

    if (charge.status === 'succeeded') {
      try {
        await transitions.markCompleted({
          retreatId: id,
          actor: { kind: 'system' },
          stripePaymentIntentId: charge.paymentIntentId,
          ...(charge.chargeId ? { stripeChargeId: charge.chargeId } : {}),
          amountCents,
        });
      } catch (err) {
        log.error('CRITICAL_manual_final_charge_succeeded_but_db_write_failed', {
          retreatId: id,
          paymentIntentId: charge.paymentIntentId,
          amountCents,
          error: (err as Error).message,
        });
        throw err;
      }
    } else if (charge.status === 'processing') {
      // Delayed settlement (ACH bank debit). Not a failure: Stripe shows
      // this PI as Pending and the money lands in a few business days.
      // Park in awaiting_final_charge with a pending payments row; the
      // payment_intent.succeeded / payment_failed webhook settles it.
      await transitions.markFinalChargeProcessing({
        retreatId: id,
        actor: { kind: 'system' },
        stripePaymentIntentId: charge.paymentIntentId,
        ...(charge.chargeId ? { stripeChargeId: charge.chargeId } : {}),
        amountCents,
      });
    } else {
      await transitions.markFinalChargeFailed({
        retreatId: id,
        actor: { kind: 'system' },
        failureCode: charge.failureCode ?? 'unknown',
        failureMessage: charge.failureMessage ?? '',
        ...(charge.paymentIntentId ? { stripePaymentIntentId: charge.paymentIntentId } : {}),
        amountCents,
        ...(charge.clientSecret ? { clientSecret: charge.clientSecret } : {}),
        attempt: failedAttempt,
      });
    }

    return c.redirect(`/admin/clients/${id}`);
  });

  if (!locked.acquired) {
    log.info('admin_charge_balance_concurrent_skipped', { retreatId: id });
    return c.redirect(
      `/admin/clients/${id}/charge-balance?error=${encodeURIComponent('Another charge attempt for this retreat is running right now. Wait a minute, refresh the client page, then try again if it is still unpaid.')}`,
    );
  }
  return locked.result;
});
