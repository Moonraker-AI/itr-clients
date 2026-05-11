/**
 * Public deposit checkout flow (DESIGN.md §6 deposit flow + §10 routes).
 *
 *   GET /c/:token/checkout          → create Stripe Checkout Session, redirect
 *   GET /c/:token/checkout/success  → post-redirect landing
 *
 * Token-gated; no auth.
 */

import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  clients,
  payments,
  retreats,
  stripeCustomers,
  therapists,
} from '../../db/schema.js';
import { formatCents } from '../../lib/pricing.js';
import { log } from '../../lib/phi-redactor.js';
import {
  createDepositCheckoutSession,
  getCheckoutSession,
  upsertCustomer,
} from '../../lib/stripe.js';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ClientShell,
  Layout,
  LinkButton,
} from '../../lib/ui/index.js';

export const publicCheckoutRoute = new Hono();

publicCheckoutRoute.get('/:token/checkout', async (c) => {
  // Bust browser + intermediary caches. Pre-v0.28.13 this route was a 302
  // straight to Stripe, and browsers (Brave/Chromium) cache 302s; after
  // the chooser landed in v0.28.13 some users still saw the old redirect
  // until a hard refresh. no-store keeps the chooser + the post-pick
  // redirect both ephemeral.
  c.header('Cache-Control', 'no-store, must-revalidate');
  c.header('Pragma', 'no-cache');

  const token = c.req.param('token');
  const ctx = await loadRetreatContextByToken(token);
  if (!ctx) return c.notFound();
  if (ctx.state !== 'awaiting_deposit') {
    return c.redirect(`/c/${token}`);
  }

  const methodRaw = c.req.query('method');
  const method: 'card' | 'us_bank_account' | null =
    methodRaw === 'card'
      ? 'card'
      : methodRaw === 'ach'
        ? 'us_bank_account'
        : null;

  // No method chosen yet - render the two-button chooser so the client
  // picks CC (no discount, instant) or ACH (discounted, slower clearing).
  if (method === null) {
    const achPct = Number(ctx.achDiscountPct);
    const safeAchPct = Number.isFinite(achPct) && achPct >= 0 && achPct < 1 ? achPct : 0;
    const ccCents = ctx.depositCents;
    const achCents = Math.round(ccCents * (1 - safeAchPct));
    const pctLabel = `${(safeAchPct * 100).toFixed(1).replace(/\.0$/, '')}%`;

    return c.html(
      <Layout title="Choose payment method - Intensive Therapy Retreats">
        <ClientShell width="xl">
          <h1 class="text-2xl font-semibold tracking-tight mb-2">
            Hi {ctx.firstName},
          </h1>
          <p class="text-muted-foreground mb-6">
            Pick how you'd like to pay your deposit. Both options take you to a
            secure Stripe checkout to enter your details.
          </p>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Credit / debit card</CardTitle>
              </CardHeader>
              <CardContent>
                <div class="text-3xl font-semibold tracking-tight mb-1">
                  {formatCents(ccCents)}
                </div>
                <p class="text-sm text-muted-foreground mb-4">
                  Charged instantly. Standard processing fees apply.
                </p>
                <LinkButton
                  href={`/c/${token}/checkout?method=card`}
                  variant="default"
                  size="default"
                  class="w-full"
                >
                  Pay by card
                </LinkButton>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  Bank transfer (ACH)
                  {safeAchPct > 0 ? (
                    <Badge variant="success" class="ml-2">
                      Save {pctLabel}
                    </Badge>
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div class="text-3xl font-semibold tracking-tight mb-1">
                  {formatCents(achCents)}
                </div>
                <p class="text-sm text-muted-foreground mb-4">
                  Lower fees, so you save {pctLabel}. Clears in 1-4 business
                  days; you'll authenticate your bank during checkout.
                </p>
                <LinkButton
                  href={`/c/${token}/checkout?method=ach`}
                  variant="default"
                  size="default"
                  class="w-full"
                >
                  Pay by bank
                </LinkButton>
              </CardContent>
            </Card>
          </div>
        </ClientShell>
      </Layout>,
    );
  }

  // Method picked - upsert the Stripe customer + create the session.
  const baseUrl = publicBaseUrl(c);
  const successUrl = `${baseUrl}/c/${token}/checkout/success?cs={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/c/${token}/checkout`;

  const { db } = await getDb();
  const [existing] = await db
    .select()
    .from(stripeCustomers)
    .where(eq(stripeCustomers.clientId, ctx.clientId));

  const upsertArgs: Parameters<typeof upsertCustomer>[0] = {
    clientId: ctx.clientId,
    firstName: ctx.firstName,
    lastName: ctx.lastName,
    email: ctx.email,
  };
  if (existing) upsertArgs.existingStripeCustomerId = existing.stripeCustomerId;

  const customer = await upsertCustomer(upsertArgs);

  if (!existing) {
    await db
      .insert(stripeCustomers)
      .values({
        clientId: ctx.clientId,
        stripeCustomerId: customer.stripeCustomerId,
      })
      .onConflictDoNothing({ target: stripeCustomers.clientId });
  } else if (existing.stripeCustomerId !== customer.stripeCustomerId) {
    await db
      .update(stripeCustomers)
      .set({
        stripeCustomerId: customer.stripeCustomerId,
        updatedAt: new Date(),
      })
      .where(eq(stripeCustomers.clientId, ctx.clientId));
  }

  // Apply ACH discount at session-creation time. CC pays the full
  // depositCents snapshot; ACH pays a discounted amount derived from the
  // retreat's frozen achDiscountPct (so it can't drift if pricing_config
  // changes mid-retreat).
  const achPct = Number(ctx.achDiscountPct);
  const safeAchPct = Number.isFinite(achPct) && achPct >= 0 && achPct < 1 ? achPct : 0;
  const chargeCents =
    method === 'us_bank_account'
      ? Math.round(ctx.depositCents * (1 - safeAchPct))
      : ctx.depositCents;

  const session = await createDepositCheckoutSession({
    clientId: ctx.clientId,
    retreatId: ctx.retreatId,
    stripeCustomerId: customer.stripeCustomerId,
    depositCents: chargeCents,
    paymentMethod: method,
    successUrl,
    cancelUrl,
    connectAccountId: ctx.connectAccountId,
    payoutPct: ctx.payoutPct,
  });

  log.info('checkout_session_created', {
    retreatId: ctx.retreatId,
    sessionId: session.sessionId,
    paymentMethod: method,
    chargeCents,
    dryRun: session.dryRun,
  });

  return c.redirect(session.url);
});

publicCheckoutRoute.get('/:token/checkout/success', async (c) => {
  const token = c.req.param('token');
  const ctx = await loadRetreatContextByToken(token);
  if (!ctx) return c.notFound();

  const sessionId = c.req.query('cs');
  let paid = false;
  if (sessionId && !sessionId.startsWith('cs_dryrun_')) {
    try {
      const session = await getCheckoutSession(sessionId);
      paid = session?.payment_status === 'paid';
    } catch (err) {
      log.error('checkout_session_lookup_failed', {
        retreatId: ctx.retreatId,
        error: (err as Error).message,
      });
    }
  } else if (sessionId?.startsWith('cs_dryrun_')) {
    paid = true;
  }

  // Pull the latest deposit row (set by the Stripe webhook). May be missing
  // if the success redirect lands before the webhook has been processed -
  // in that case we still show the planned amount + a "processing" status.
  const { db } = await getDb();
  const [depositRow] = await db
    .select({
      amountCents: payments.amountCents,
      status: payments.status,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(eq(payments.retreatId, ctx.retreatId), eq(payments.kind, 'deposit')))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  const depositAmount = depositRow?.amountCents ?? ctx.depositCents;
  const depositStatus = depositRow?.status ?? (paid ? 'pending_webhook' : 'pending');
  const paidAt = depositRow?.createdAt ?? null;

  return c.html(
    <Layout title={`Deposit ${paid ? 'received' : 'pending'} - Intensive Therapy Retreats`}>
      <ClientShell>
        <Card>
          <CardHeader>
            <CardTitle>
              {paid
                ? 'Thanks so much for your deposit! It has been received.'
                : 'Your deposit is processing.'}
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-4 text-sm">
            <p>
              {paid
                ? "Your therapist will confirm your retreat dates next. We'll email you when they do."
                : "We haven't received the payment confirmation yet. Refresh in a moment, or check your email."}
            </p>

            <div class="rounded-md border border-border bg-muted/40 p-4">
              <div class="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                Deposit status
              </div>
              <dl class="grid grid-cols-[120px_1fr] gap-y-1.5 text-sm">
                <dt class="text-muted-foreground">Amount</dt>
                <dd class="font-medium">{formatCents(depositAmount)}</dd>
                <dt class="text-muted-foreground">Status</dt>
                <dd>
                  {depositStatus === 'succeeded' ? (
                    <Badge variant="success">received</Badge>
                  ) : depositStatus === 'pending_webhook' ? (
                    <Badge variant="secondary">received · syncing</Badge>
                  ) : depositStatus === 'failed' ? (
                    <Badge variant="destructive">failed</Badge>
                  ) : (
                    <Badge variant="secondary">processing</Badge>
                  )}
                </dd>
                {paidAt ? (
                  <>
                    <dt class="text-muted-foreground">Recorded</dt>
                    <dd>{paidAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</dd>
                  </>
                ) : null}
              </dl>
            </div>

            <LinkButton href={`/c/${token}`} variant="outline">
              Back to retreat status
            </LinkButton>
          </CardContent>
        </Card>
      </ClientShell>
    </Layout>,
  );
});

async function loadRetreatContextByToken(token: string) {
  const { db } = await getDb();
  const [row] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      clientId: retreats.clientId,
      depositCents: retreats.depositCents,
      achDiscountPct: retreats.achDiscountPct,
      firstName: clients.firstName,
      lastName: clients.lastName,
      email: clients.email,
      // Phase C (v0.25.0). NULL connect id ⇒ legacy direct charge.
      connectAccountId: therapists.stripeConnectAccountId,
      payoutPct: therapists.therapistPayoutPct,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .innerJoin(therapists, eq(retreats.therapistId, therapists.id))
    .where(eq(retreats.clientToken, token));
  return row ?? null;
}

function publicBaseUrl(c: import('hono').Context): string {
  return process.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin;
}
