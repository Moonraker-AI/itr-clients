/**
 * Single Stripe wrapper module (DESIGN.md §16).
 *
 * EVERY Stripe API call MUST go through this module. Direct `stripe-node`
 * imports outside this file are a CI lint violation (added in M3+).
 *
 * Why: Stripe operates under HIPAA's §1179 payment-processing exemption.
 * The exemption holds only if PHI never enters Stripe systems. This wrapper
 * enforces the §16 field-by-field rules:
 *   - description must match an allow-list of generic strings
 *   - metadata keys must match an allow-list
 *   - metadata values must NOT look like emails / phones / dates / >50 chars
 *   - statement_descriptor uses the org's generic merchant name
 *
 * Validation throws synchronously before any HTTP call so a violation is
 * surfaced in tests + admin UI, never silently committed to a Stripe row.
 *
 * Dev mode: when `STRIPE_SECRET_KEY` is unset the wrapper auto-dry-runs:
 * customer + session creation return synthetic ids, no network call. Lets
 * the admin form + state machine exercise their happy path without a key.
 */

import Stripe from 'stripe';

import { log } from './phi-redactor.js';

const ALLOWED_DESCRIPTIONS = new Set<string>([
  'ITR client',
  'Retreat services',
  'Retreat services - 0.5 days',
  'Retreat services - 1 day',
  'Retreat services - 1.5 days',
  'Retreat services - 2 days',
  'Retreat services - 2.5 days',
  'Retreat services - 3 days',
  'Retreat services - 3.5 days',
  'Retreat services - 4 days',
  'Retreat services - 4.5 days',
  'Retreat services - 5 days',
  'Retreat deposit',
  'Retreat balance',
  'Retreat refund',
]);

const ALLOWED_METADATA_KEYS = new Set<string>([
  'client_id',
  'retreat_id',
  'payment_kind',
  'stripe_customer_id',
]);

const STATEMENT_DESCRIPTOR = 'ITR Retreats';

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/;
const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_TOKEN_RE = /^[a-z_]+$/; // payment_kind etc.

class StripePhiViolation extends Error {
  constructor(public readonly field: string, message: string) {
    super(`Stripe PHI rule violation on ${field}: ${message}`);
    this.name = 'StripePhiViolation';
  }
}

function assertDescription(d: string | undefined): void {
  if (d == null) return;
  if (!ALLOWED_DESCRIPTIONS.has(d)) {
    throw new StripePhiViolation(
      'description',
      `"${d}" is not in the allow-list (DESIGN §16)`,
    );
  }
}

function assertMetadata(meta: Record<string, string> | undefined): void {
  if (!meta) return;
  for (const [key, value] of Object.entries(meta)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      throw new StripePhiViolation(
        `metadata.${key}`,
        `key not in allow-list (DESIGN §16)`,
      );
    }
    if (typeof value !== 'string') {
      throw new StripePhiViolation(
        `metadata.${key}`,
        `value must be a string, got ${typeof value}`,
      );
    }
    if (value.length > 50) {
      throw new StripePhiViolation(
        `metadata.${key}`,
        `value exceeds 50 chars`,
      );
    }
    if (EMAIL_RE.test(value)) {
      throw new StripePhiViolation(`metadata.${key}`, 'value looks like an email');
    }
    if (PHONE_RE.test(value)) {
      throw new StripePhiViolation(`metadata.${key}`, 'value looks like a phone');
    }
    if (DATE_RE.test(value)) {
      throw new StripePhiViolation(`metadata.${key}`, 'value looks like a date');
    }
    // UUIDs and short snake_case tokens (payment_kind values) are explicitly
    // allowed shapes. Anything else gets flagged conservatively.
    if (
      !UUID_RE.test(value) &&
      !SHORT_TOKEN_RE.test(value) &&
      !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
      throw new StripePhiViolation(
        `metadata.${key}`,
        'value contains characters outside the opaque-id shape',
      );
    }
  }
}

let cachedClient: Stripe | null = null;

function getClient(): Stripe | null {
  if (cachedClient) return cachedClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null; // dry-run mode
  // Timeouts + retries hardened in M9 (audit #19): default Stripe SDK
  // timeout is 80s and retries=0; a Stripe outage would pin Cloud Run
  // request slots until the 60s service timeout fires. 15s + 2 retries
  // bounds the worst-case at ~45s with one network blip absorbed.
  cachedClient = new Stripe(key, {
    // Pin the API version so a Stripe-side default change doesn't silently
    // alter response shapes mid-deploy. Bumped intentionally with the SDK.
    apiVersion: '2026-04-22.dahlia',
    // Keep `appInfo.version` in lockstep with `package.json` "version".
    // Stripe surfaces this string in their dashboard's API request log so
    // mismatched values make per-revision debugging harder than it needs.
    appInfo: { name: 'itr-client-hq', version: '0.8.10' },
    timeout: 15_000,
    maxNetworkRetries: 2,
  });
  return cachedClient;
}

function dryRun(): boolean {
  return !process.env.STRIPE_SECRET_KEY;
}

/**
 * Find or create the Stripe Customer for a client. Stores only non-PHI
 * billing data — name + email + a generic description (DESIGN §16).
 */
export interface UpsertCustomerArgs {
  clientId: string;
  firstName: string;
  lastName: string;
  email: string;
  /** Existing stripe_customer_id from stripe_customers row, if any. */
  existingStripeCustomerId?: string;
}

export interface UpsertCustomerResult {
  stripeCustomerId: string;
  dryRun: boolean;
}

export async function upsertCustomer(
  args: UpsertCustomerArgs,
): Promise<UpsertCustomerResult> {
  const desc = 'ITR client';
  assertDescription(desc);
  const metadata = { client_id: args.clientId };
  assertMetadata(metadata);

  if (dryRun()) {
    const stripeCustomerId =
      args.existingStripeCustomerId ?? `cus_dryrun_${args.clientId.slice(0, 8)}`;
    log.info('stripe_dry_run_upsert_customer', { clientId: args.clientId, stripeCustomerId });
    return { stripeCustomerId, dryRun: true };
  }

  const client = getClient()!;
  if (args.existingStripeCustomerId) {
    const updated = await client.customers.update(args.existingStripeCustomerId, {
      name: `${args.firstName} ${args.lastName}`,
      email: args.email,
      description: desc,
      metadata,
    });
    return { stripeCustomerId: updated.id, dryRun: false };
  }
  const created = await client.customers.create({
    name: `${args.firstName} ${args.lastName}`,
    email: args.email,
    description: desc,
    metadata,
  });
  return { stripeCustomerId: created.id, dryRun: false };
}

/**
 * Create a Checkout Session for the deposit. Captures the payment method so
 * the final balance can be charged off-session at retreat completion
 * (M5).
 */
export interface CreateDepositSessionArgs {
  clientId: string;
  retreatId: string;
  stripeCustomerId: string;
  depositCents: number;
  /** 'card' for now; ACH path lands later via Customer Portal. */
  paymentMethod: 'card';
  successUrl: string;
  cancelUrl: string;
}

export interface CreateSessionResult {
  sessionId: string;
  url: string;
  dryRun: boolean;
}

export async function createDepositCheckoutSession(
  args: CreateDepositSessionArgs,
): Promise<CreateSessionResult> {
  const description = 'Retreat deposit';
  assertDescription(description);
  const metadata = {
    client_id: args.clientId,
    retreat_id: args.retreatId,
    payment_kind: 'deposit',
  };
  assertMetadata(metadata);

  if (dryRun()) {
    const sessionId = `cs_dryrun_${args.retreatId.slice(0, 8)}`;
    log.info('stripe_dry_run_checkout_session', {
      retreatId: args.retreatId,
      sessionId,
      amount: args.depositCents,
    });
    return { sessionId, url: args.successUrl, dryRun: true };
  }

  const client = getClient()!;
  const session = await client.checkout.sessions.create({
    mode: 'payment',
    customer: args.stripeCustomerId,
    payment_method_types: [args.paymentMethod],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: args.depositCents,
          product_data: { name: description },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      // Save the card on the Customer for the off-session final charge.
      setup_future_usage: 'off_session',
      description,
      metadata,
      statement_descriptor_suffix: STATEMENT_DESCRIPTOR.slice(0, 22),
    },
    metadata,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });

  return {
    sessionId: session.id,
    url: session.url ?? args.successUrl,
    dryRun: false,
  };
}

/**
 * Charge the final balance off-session against a previously saved
 * payment method (DESIGN §6 final balance flow, M5).
 *
 * Behaviour:
 *   - Synchronous attempt with `confirm: true` — the result of the call
 *     is authoritative; webhooks are a redundant ack.
 *   - Idempotent on `idempotencyKey` (callers pass `final:<retreatId>:<attempt>`).
 *   - Maps Stripe outcomes to a small enum so the state machine doesn't
 *     have to know about Stripe error shapes.
 */
export type FinalChargeStatus =
  | 'succeeded'
  | 'requires_action' // 3DS / authentication_required
  | 'failed';

export interface ChargeFinalBalanceArgs {
  retreatId: string;
  clientId: string;
  stripeCustomerId: string;
  /** Saved PM id — usually `stripe_customers.default_payment_method_id`. */
  paymentMethodId: string;
  amountCents: number;
  /** Idempotency key for the PaymentIntent create. */
  idempotencyKey: string;
}

export interface ChargeFinalBalanceResult {
  status: FinalChargeStatus;
  paymentIntentId: string;
  chargeId: string | null;
  /** Populated for `failed` (and sometimes `requires_action`). */
  failureCode: string | null;
  failureMessage: string | null;
  /** Populated for `requires_action` so the recovery email can hand off
   *  to the hosted-confirmation flow (M6). */
  clientSecret: string | null;
  dryRun: boolean;
}

export async function chargeFinalBalance(
  args: ChargeFinalBalanceArgs,
): Promise<ChargeFinalBalanceResult> {
  const description = 'Retreat balance';
  assertDescription(description);
  const metadata = {
    client_id: args.clientId,
    retreat_id: args.retreatId,
    payment_kind: 'final',
  };
  assertMetadata(metadata);

  if (args.amountCents <= 0) {
    throw new Error(`chargeFinalBalance: amountCents must be > 0`);
  }

  if (dryRun()) {
    const paymentIntentId = `pi_dryrun_final_${args.retreatId.slice(0, 8)}`;
    log.info('stripe_dry_run_charge_final', {
      retreatId: args.retreatId,
      paymentIntentId,
      amount: args.amountCents,
    });
    return {
      status: 'succeeded',
      paymentIntentId,
      chargeId: `ch_dryrun_${args.retreatId.slice(0, 8)}`,
      failureCode: null,
      failureMessage: null,
      clientSecret: null,
      dryRun: true,
    };
  }

  const client = getClient()!;
  try {
    const pi = await client.paymentIntents.create(
      {
        amount: args.amountCents,
        currency: 'usd',
        customer: args.stripeCustomerId,
        payment_method: args.paymentMethodId,
        off_session: true,
        confirm: true,
        description,
        metadata,
        statement_descriptor_suffix: STATEMENT_DESCRIPTOR.slice(0, 22),
      },
      { idempotencyKey: args.idempotencyKey },
    );
    return mapPaymentIntent(pi);
  } catch (err) {
    // `off_session: true` failures throw with `err.payment_intent` populated
    // when Stripe has a PI to attach to (e.g. authentication_required).
    const e = err as {
      code?: string;
      message: string;
      payment_intent?: Stripe.PaymentIntent;
    };
    if (e.payment_intent) {
      const mapped = mapPaymentIntent(e.payment_intent);
      log.warn('stripe_final_charge_error_with_pi', {
        retreatId: args.retreatId,
        status: mapped.status,
        code: e.code,
      });
      return {
        ...mapped,
        failureCode: mapped.failureCode ?? e.code ?? null,
        failureMessage: mapped.failureMessage ?? e.message,
      };
    }
    log.error('stripe_final_charge_error_no_pi', {
      retreatId: args.retreatId,
      code: e.code,
      message: e.message,
    });
    return {
      status: 'failed',
      paymentIntentId: '',
      chargeId: null,
      failureCode: e.code ?? 'unknown',
      failureMessage: e.message,
      clientSecret: null,
      dryRun: false,
    };
  }
}

function mapPaymentIntent(pi: Stripe.PaymentIntent): ChargeFinalBalanceResult {
  let chargeId: string | null = null;
  if (typeof pi.latest_charge === 'string') chargeId = pi.latest_charge;
  else if (pi.latest_charge) chargeId = pi.latest_charge.id;
  if (pi.status === 'succeeded') {
    return {
      status: 'succeeded',
      paymentIntentId: pi.id,
      chargeId,
      failureCode: null,
      failureMessage: null,
      clientSecret: null,
      dryRun: false,
    };
  }
  if (pi.status === 'requires_action' || pi.status === 'requires_confirmation') {
    return {
      status: 'requires_action',
      paymentIntentId: pi.id,
      chargeId: null,
      failureCode: pi.last_payment_error?.code ?? null,
      failureMessage: pi.last_payment_error?.message ?? null,
      clientSecret: pi.client_secret,
      dryRun: false,
    };
  }
  return {
    status: 'failed',
    paymentIntentId: pi.id,
    chargeId: null,
    failureCode: pi.last_payment_error?.code ?? pi.status,
    failureMessage: pi.last_payment_error?.message ?? null,
    clientSecret: null,
    dryRun: false,
  };
}

/**
 * Webhook signature verification. Returns the parsed Stripe event or null
 * (and logs) on a bad signature — caller should respond 400 in that case.
 */
export function verifyWebhookSignature(args: {
  rawBody: string;
  signatureHeader: string;
}): Stripe.Event | null {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    log.error('stripe_webhook_secret_unset', {});
    return null;
  }
  const client = getClient();
  if (!client) {
    log.error('stripe_secret_key_unset_for_webhook', {});
    return null;
  }
  try {
    return client.webhooks.constructEvent(args.rawBody, args.signatureHeader, secret);
  } catch (err) {
    log.error('stripe_webhook_signature_invalid', {
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Refund a previously-succeeded PaymentIntent (DESIGN §6 cancellation/
 * refund, M7). Idempotent on `idempotencyKey` — caller passes
 * `refund:<paymentIntentId>:<attempt>` so retried submissions don't
 * double-refund.
 *
 *   - amountCents=null  → full refund of the remaining refundable amount.
 *   - amountCents>0     → partial refund.
 *
 * Stripe accepts an enumerated `reason` of
 * `duplicate | fraudulent | requested_by_customer`. We always pass
 * `requested_by_customer` (operationally accurate for retreats) and
 * record the admin's free-text reason in our payments table + audit
 * event payload — never in Stripe metadata, where free-text could be PHI.
 */
export interface RefundPaymentArgs {
  paymentIntentId: string;
  /** null = full remaining refundable amount. */
  amountCents: number | null;
  idempotencyKey: string;
  retreatId: string;
  clientId: string;
}

export interface RefundPaymentResult {
  refundId: string;
  amountCents: number;
  status: string;
  dryRun: boolean;
}

export async function refundPayment(
  args: RefundPaymentArgs,
): Promise<RefundPaymentResult> {
  const description = 'Retreat refund';
  assertDescription(description);
  const metadata = {
    client_id: args.clientId,
    retreat_id: args.retreatId,
    payment_kind: 'refund',
  };
  assertMetadata(metadata);

  if (dryRun()) {
    log.info('stripe_dry_run_refund', {
      paymentIntentId: args.paymentIntentId,
      amount: args.amountCents,
    });
    return {
      refundId: `re_dryrun_${args.retreatId.slice(0, 8)}`,
      amountCents: args.amountCents ?? 0,
      status: 'succeeded',
      dryRun: true,
    };
  }

  const client = getClient()!;
  const refund = await client.refunds.create(
    {
      payment_intent: args.paymentIntentId,
      ...(args.amountCents != null ? { amount: args.amountCents } : {}),
      reason: 'requested_by_customer',
      metadata,
    },
    { idempotencyKey: args.idempotencyKey },
  );
  return {
    refundId: refund.id,
    amountCents: refund.amount,
    status: refund.status ?? 'unknown',
    dryRun: false,
  };
}

/**
 * Create a Stripe Customer Portal session so the client can update their
 * saved payment method (DESIGN §6 failure recovery, M6). Returned URL is
 * a one-shot Stripe-hosted page; we redirect the client to it.
 */
export interface CreatePortalSessionArgs {
  stripeCustomerId: string;
  /** Where Stripe redirects the client after they finish in the portal. */
  returnUrl: string;
}

export interface CreatePortalSessionResult {
  url: string;
  dryRun: boolean;
}

export async function createPortalSession(
  args: CreatePortalSessionArgs,
): Promise<CreatePortalSessionResult> {
  if (dryRun()) {
    log.info('stripe_dry_run_portal_session', { stripeCustomerId: args.stripeCustomerId });
    return { url: args.returnUrl, dryRun: true };
  }
  const client = getClient()!;
  const session = await client.billingPortal.sessions.create({
    customer: args.stripeCustomerId,
    return_url: args.returnUrl,
  });
  return { url: session.url, dryRun: false };
}

/**
 * Retrieve a PaymentIntent. Used by the deposit webhook to surface the
 * saved payment_method id (so M5's off-session charge has something to
 * reference) and the latest_charge id.
 */
export async function retrievePaymentIntent(
  paymentIntentId: string,
): Promise<Stripe.PaymentIntent | null> {
  if (dryRun()) return null;
  const client = getClient()!;
  return client.paymentIntents.retrieve(paymentIntentId, {
    expand: ['payment_method', 'latest_charge'],
  });
}

/**
 * Retrieve a Checkout Session — used by the success page to confirm payment.
 */
export async function getCheckoutSession(
  sessionId: string,
): Promise<Stripe.Checkout.Session | null> {
  if (dryRun()) {
    return null;
  }
  const client = getClient()!;
  return client.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent'],
  });
}

export { StripePhiViolation };
