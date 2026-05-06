/**
 * /admin/clients/:id/complete - therapist completion form (M5).
 */

import { Hono } from 'hono';
import { and, eq, sum } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { clients, payments, retreats, stripeCustomers } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { ensureCsrfToken, verifyCsrfToken } from '../../lib/csrf.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';
import { chargeFinalBalance } from '../../lib/stripe.js';
import { formatCents } from '../../lib/pricing.js';
import {
  AdminShell,
  Alert,
  AlertDescription,
  AlertTitle,
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
} from '../../lib/ui/index.js';

export const adminCompleteRoute = new Hono();

adminCompleteRoute.get('/:id/complete', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();

  const [row] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      therapistId: retreats.therapistId,
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
  if (!therapistCanAccess(c.get('user'), row.therapistId)) return c.notFound();

  const error = c.req.query('error');
  const csrfToken = ensureCsrfToken(c);
  const user = c.get('user');
  const fullVal = row.actualFullDays ?? row.plannedFullDays;
  const halfVal = row.actualHalfDays ?? row.plannedHalfDays;
  const clientName = `${row.clientFirstName} ${row.clientLastName}`;

  return c.html(
    <Layout title="Complete retreat - ITR Clients">
      <AdminShell user={user} current="dashboard">
        <PageHeader
          title="Complete retreat"
          description={`${clientName} · ${id.slice(0, 8)}`}
        >
          <LinkButton href={`/admin/clients/${id}`} variant="ghost" size="sm">
            ← back
          </LinkButton>
        </PageHeader>

        <div class="max-w-2xl space-y-4">
          {row.state !== 'in_progress' ? (
            <Alert variant="destructive">
              <AlertTitle>Wrong state</AlertTitle>
              <AlertDescription>
                State is <code class="font-mono">{row.state}</code> - only{' '}
                <code class="font-mono">in_progress</code> can submit completion.
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
              <CardTitle>Snapshot</CardTitle>
              <CardDescription>
                Planned: {row.plannedFullDays} full + {row.plannedHalfDays} half · Rates:{' '}
                {formatCents(row.fullDayRateCents)} full
                {row.halfDayRateCents == null
                  ? ''
                  : ` / ${formatCents(row.halfDayRateCents)} half`}{' '}
                · Deposit paid: {formatCents(row.depositCents)}
              </CardDescription>
            </CardHeader>
            <CardContent class="text-sm text-muted-foreground">
              Submitting will (1) lock actual day counts, (2) attempt the off-session final charge against
              the saved payment method, (3) flip state to <code class="font-mono">completed</code> on
              success or <code class="font-mono">final_charge_failed</code> on failure.
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Actual day counts</CardTitle>
            </CardHeader>
            <CardContent>
              <form method="post" class="space-y-4">
                <CsrfInput token={csrfToken} />
                <div class="grid grid-cols-2 gap-4">
                  <Field label="Actual full days" for="actual_full_days">
                    <Input
                      id="actual_full_days"
                      name="actual_full_days"
                      type="number"
                      min="0"
                      step="1"
                      value={String(fullVal)}
                      required
                    />
                  </Field>
                  <Field label="Actual half days" for="actual_half_days">
                    <Input
                      id="actual_half_days"
                      name="actual_half_days"
                      type="number"
                      min="0"
                      step="1"
                      value={String(halfVal)}
                      required
                    />
                  </Field>
                </div>
                <Button type="submit">Submit + charge balance</Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </AdminShell>
    </Layout>,
  );
});

adminCompleteRoute.post('/:id/complete', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();
  const [owner] = await db
    .select({ therapistId: retreats.therapistId })
    .from(retreats)
    .where(eq(retreats.id, id));
  if (!owner) return c.notFound();
  if (!therapistCanAccess(c.get('user'), owner.therapistId)) return c.notFound();

  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
  const actualFullDays = Number(form.get('actual_full_days') ?? 0);
  const actualHalfDays = Number(form.get('actual_half_days') ?? 0);

  const MAX_DAY_COUNT = 365;
  if (
    !Number.isInteger(actualFullDays) ||
    !Number.isInteger(actualHalfDays) ||
    actualFullDays < 0 ||
    actualHalfDays < 0 ||
    actualFullDays > MAX_DAY_COUNT ||
    actualHalfDays > MAX_DAY_COUNT ||
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
    // Audit #17: `final_zero_${id}` is collision-safe across re-completion
    // because retreat ids are PKs, and submitCompletion refuses a second
    // submission with different day counts. Refund.ts:128 short-circuits
    // this synthetic PI since there is no Stripe charge to reverse.
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
      failureMessage: 'no saved payment method on stripe_customers - cannot off-session charge',
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
    log.info('final_charge_db_write_starting', {
      retreatId: id,
      paymentIntentId: charge.paymentIntentId,
      amountCents: balance,
    });
    try {
      await transitions.markCompleted({
        retreatId: id,
        actor: { kind: 'system' },
        stripePaymentIntentId: charge.paymentIntentId,
        ...(charge.chargeId ? { stripeChargeId: charge.chargeId } : {}),
        amountCents: balance,
      });
    } catch (err) {
      log.error('CRITICAL_final_charge_succeeded_but_db_write_failed', {
        retreatId: id,
        paymentIntentId: charge.paymentIntentId,
        amountCents: balance,
        error: (err as Error).message,
      });
      throw err;
    }
  } else {
    await transitions.markFinalChargeFailed({
      retreatId: id,
      actor: { kind: 'system' },
      failureCode: charge.failureCode ?? 'unknown',
      failureMessage: charge.failureMessage ?? '',
      ...(charge.paymentIntentId ? { stripePaymentIntentId: charge.paymentIntentId } : {}),
      amountCents: balance,
      ...(charge.clientSecret ? { clientSecret: charge.clientSecret } : {}),
    });
  }

  return c.redirect(`/admin/clients/${id}`);
});
