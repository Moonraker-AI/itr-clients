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
    // Allow-list match comes first. v0.28.23: a retreat UUID with 10+
    // contiguous digit-only characters (e.g. third + fourth groups
    // happening to be all digits) was tripping PHONE_RE downstream
    // and breaking deposit checkout for those retreats. UUIDs +
    // short snake_case tokens are intentional opaque ids and should
    // never be evaluated against the PHI heuristics.
    if (UUID_RE.test(value) || SHORT_TOKEN_RE.test(value)) {
      continue;
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
    // Catch-all for anything outside the opaque-id shape.
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new StripePhiViolation(
        `metadata.${key}`,
        'value contains characters outside the opaque-id shape',
      );
    }
  }
}

/**
 * Stripe US-card processing fee estimate. 2.9% + 30¢ is the standard
 * baseline for domestic cards. Real fees vary by card type (intl +1.5%,
 * premium rewards cards higher), and Connect Express adds a separate
 * 0.25% + 25¢ on the connected-account portion. v0.27.0 absorbs all that
 * variance on the platform side rather than running a balance_transaction
 * true-up. If real-world deltas trend > $5/charge after a month of data,
 * see the v0.28+ true-up path noted in PROJECT.md.
 */
const STRIPE_FEE_RATE_BPS = 290; // 2.9% in basis points
const STRIPE_FEE_FLAT_CENTS = 30;

export function estimateStripeFeeCents(grossCents: number): number {
  if (grossCents <= 0) return 0;
  return Math.round((grossCents * STRIPE_FEE_RATE_BPS) / 10_000) + STRIPE_FEE_FLAT_CENTS;
}

/**
 * Phase C (v0.25.0+, fee-deducted variant in v0.27.0). Resolve
 * destination-charge params for a charge.
 *
 * Model: pre-deduct estimated Stripe processing fee from the GROSS amount,
 * THEN apply the therapist's payout pct to the NET. Platform retains the
 * difference, which covers the fee Stripe deducts from platform balance -
 * leaving the platform's 40% net cleanly. Therapists are unaffected by fee
 * variance; platform absorbs sub-cent rounding + ±estimate deltas.
 *
 * NULL connect id ⇒ legacy direct-charge flow (no destination, no app fee).
 *
 * Bambi at 100% pct ⇒ therapist_share = entire NET, app_fee = est_fee.
 * Stripe deducts the fee from platform balance via app_fee, platform nets 0,
 * Bambi nets ~$970 on a $1000 charge.
 *
 * Math (gross G, pct P, est fee F):
 *   net  = G - F
 *   ts   = floor(net * P / 100)               // therapist transfer
 *   fee  = G - ts                              // application_fee_amount
 *
 * `ts` floored so therapists never under-paid by sub-cent rounding;
 * platform absorbs remainder. `fee` is clamped at `G` for the
 * pathological pct=0 case (Stripe rejects app_fee > amount).
 */
export function buildConnectParams(args: {
  connectAccountId: string | null;
  payoutPct: string | number | null;
  amountCents: number;
}): {
  transferData: { destination: string } | null;
  applicationFeeAmount: number | null;
} {
  if (!args.connectAccountId) {
    return { transferData: null, applicationFeeAmount: null };
  }
  const pctRaw =
    typeof args.payoutPct === 'string' ? Number(args.payoutPct) : args.payoutPct;
  if (pctRaw == null || !Number.isFinite(pctRaw)) {
    throw new Error(
      `buildConnectParams: payoutPct required when connectAccountId set (got ${String(args.payoutPct)})`,
    );
  }
  if (pctRaw < 0 || pctRaw > 100) {
    throw new Error(`buildConnectParams: payoutPct out of range: ${pctRaw}`);
  }
  const estFeeCents = estimateStripeFeeCents(args.amountCents);
  const netCents = Math.max(0, args.amountCents - estFeeCents);
  const therapistShare = Math.floor((netCents * pctRaw) / 100);
  const applicationFeeAmount = Math.min(
    args.amountCents,
    args.amountCents - therapistShare,
  );
  return {
    transferData: { destination: args.connectAccountId },
    applicationFeeAmount,
  };
}

let cachedClient: Stripe | null = null;
/**
 * Errors that mean "the Connect destination on this charge is broken",
 * regardless of the underlying reason. Caught + retried as a direct
 * charge in both deposit checkout and final off-session paths.
 *
 *   - "cannot be set to your own account": v0.28.8 - destination equals
 *     the platform's own account.
 *   - "No such destination": v0.28.24 - destination is a Connect id from
 *     a different Stripe mode (live vs. test) or simply doesn't exist
 *     on this platform.
 *   - "transfer_data[destination]": generic Stripe validation error on
 *     the destination param shape.
 */
const SELF_DESTINATION_ERROR_RE =
  /cannot be set to your own account|no such destination|transfer_data\[destination\]/i;

/**
 * Stripe rejects `transfer_data[destination]` when the destination equals
 * the platform's own account. Happens when a therapist's
 * `stripeConnectAccountId` matches the platform (mis-seeded, or a test-key
 * env collides with a live therapist row). True for the surfaced error
 * "param cannot be set to your own account" or any variant we observe.
 */
function isSelfDestinationError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : '';
  return SELF_DESTINATION_ERROR_RE.test(msg);
}

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
    appInfo: { name: 'itr-client-hq', version: '0.28.0' },
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
 * billing data - name + email + a generic description (DESIGN §16).
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
  /**
   * Stripe `payment_method_types` entry. v0.28.13 adds the ACH path:
   * client picks card vs. us_bank_account on the in-app chooser before
   * we create the session. Discount is applied to `depositCents` by
   * the caller, so this field is purely the Stripe method selector.
   */
  paymentMethod: 'card' | 'us_bank_account';
  successUrl: string;
  cancelUrl: string;
  /**
   * Phase C (v0.25.0). Therapist's Stripe Connect account; when present the
   * checkout becomes a destination charge: Stripe routes therapist's share
   * automatically at capture and keeps `application_fee_amount` on the
   * platform. NULL preserves the legacy direct-charge flow (e.g. Ross,
   * platform-owner rows).
   */
  connectAccountId?: string | null;
  /**
   * Therapist's payout share (0..100). Required when `connectAccountId` is
   * set. 100 means application_fee_amount=0 - all funds to the therapist
   * (today only Bambi). Caller may pass either string ('80', from drizzle's
   * numeric type) or number.
   */
  payoutPct?: string | number | null;
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

  const buildSessionParams = (useConnect: boolean) => {
    const connect = useConnect
      ? buildConnectParams({
          connectAccountId: args.connectAccountId ?? null,
          payoutPct: args.payoutPct ?? null,
          amountCents: args.depositCents,
        })
      : { transferData: null, applicationFeeAmount: null };
    return {
      mode: 'payment' as const,
      customer: args.stripeCustomerId,
      payment_method_types: [args.paymentMethod],
      line_items: [
        {
          price_data: {
            currency: 'usd' as const,
            unit_amount: args.depositCents,
            product_data: { name: description },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        // Save the card on the Customer for the off-session final charge.
        setup_future_usage: 'off_session' as const,
        description,
        metadata,
        statement_descriptor_suffix: STATEMENT_DESCRIPTOR.slice(0, 22),
        ...(connect.transferData ? { transfer_data: connect.transferData } : {}),
        ...(connect.applicationFeeAmount != null
          ? { application_fee_amount: connect.applicationFeeAmount }
          : {}),
      },
      metadata,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    };
  };

  let session;
  try {
    session = await client.checkout.sessions.create(buildSessionParams(true));
  } catch (err) {
    // Self-destination guard: if the therapist's Connect account id matches
    // the platform's own, Stripe rejects transfer_data[destination]. Retry
    // as a direct charge so the deposit still goes through; surface a warn
    // so an operator can fix the seeded Connect id later.
    if (args.connectAccountId && isSelfDestinationError(err)) {
      log.warn('stripe_connect_self_destination_fallback', {
        retreatId: args.retreatId,
        destination: args.connectAccountId,
        error: (err as Error).message,
      });
      session = await client.checkout.sessions.create(buildSessionParams(false));
    } else {
      throw err;
    }
  }

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
 *   - Synchronous attempt with `confirm: true` - the result of the call
 *     is authoritative; webhooks are a redundant ack.
 *   - Idempotent on `idempotencyKey` (callers pass `final:<retreatId>:<attempt>`).
 *   - Maps Stripe outcomes to a small enum so the state machine doesn't
 *     have to know about Stripe error shapes.
 */
export type FinalChargeStatus =
  | 'succeeded'
  | 'requires_action' // 3DS / authentication_required
  | 'processing' // delayed settlement (ACH bank debit) - money lands in ~4 business days
  | 'failed';

export interface ChargeFinalBalanceArgs {
  retreatId: string;
  clientId: string;
  stripeCustomerId: string;
  /** Saved PM id - usually `stripe_customers.default_payment_method_id`. */
  paymentMethodId: string;
  amountCents: number;
  /** Idempotency key for the PaymentIntent create. */
  idempotencyKey: string;
  /** See CreateDepositSessionArgs.connectAccountId. NULL = legacy direct charge. */
  connectAccountId?: string | null;
  /** See CreateDepositSessionArgs.payoutPct. */
  payoutPct?: string | number | null;
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

  const buildPIParams = (useConnect: boolean) => {
    const connect = useConnect
      ? buildConnectParams({
          connectAccountId: args.connectAccountId ?? null,
          payoutPct: args.payoutPct ?? null,
          amountCents: args.amountCents,
        })
      : { transferData: null, applicationFeeAmount: null };
    return {
      amount: args.amountCents,
      currency: 'usd' as const,
      customer: args.stripeCustomerId,
      payment_method: args.paymentMethodId,
      off_session: true,
      confirm: true,
      description,
      metadata,
      statement_descriptor_suffix: STATEMENT_DESCRIPTOR.slice(0, 22),
      ...(connect.transferData ? { transfer_data: connect.transferData } : {}),
      ...(connect.applicationFeeAmount != null
        ? { application_fee_amount: connect.applicationFeeAmount }
        : {}),
    };
  };

  try {
    let pi;
    try {
      pi = await client.paymentIntents.create(buildPIParams(true), {
        idempotencyKey: args.idempotencyKey,
      });
    } catch (innerErr) {
      // Self-destination guard - same shape as the deposit checkout path.
      if (args.connectAccountId && isSelfDestinationError(innerErr)) {
        log.warn('stripe_connect_self_destination_fallback', {
          retreatId: args.retreatId,
          destination: args.connectAccountId,
          error: (innerErr as Error).message,
        });
        pi = await client.paymentIntents.create(buildPIParams(false), {
          // Re-use the same idempotency key. Stripe's idempotency layer
          // returns the prior failed response for the same key, so we
          // append :no-connect to scope this fallback's idempotency
          // distinctly from the connect attempt.
          idempotencyKey: `${args.idempotencyKey}:no-connect`,
        });
      } else {
        throw innerErr;
      }
    }
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

/** Exported for tests only. */
export function mapPaymentIntent(pi: Stripe.PaymentIntent): ChargeFinalBalanceResult {
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
  if (pi.status === 'processing') {
    // ACH (us_bank_account) debits confirm synchronously but settle days
    // later. This is NOT a failure: the money is in flight. Callers park
    // the retreat in awaiting_final_charge and let the
    // payment_intent.succeeded / payment_intent.payment_failed webhook
    // resolve it. Mapping this to `failed` (the pre-fix behaviour) flipped
    // the retreat to final_charge_failed while Stripe showed Pending, and
    // primed the retry cron to double-debit the client 24h later.
    return {
      status: 'processing',
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
 * (and logs) on a bad signature - caller should respond 400 in that case.
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
 * refund, M7). Idempotent on `idempotencyKey` - caller passes
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
 * event payload - never in Stripe metadata, where free-text could be PHI.
 */
export interface RefundPaymentArgs {
  paymentIntentId: string;
  /** null = full remaining refundable amount. */
  amountCents: number | null;
  idempotencyKey: string;
  retreatId: string;
  clientId: string;
  /**
   * Phase C (v0.27.0). True when the original charge used a destination
   * transfer (`transfer_data.destination` was set). Adds:
   *   - `reverse_transfer: true`        - debits connected account back
   *   - `refund_application_fee: true`  - refunds platform's app fee
   *   proportionally
   * so a refund unwinds every leg of the original charge. False/legacy
   * direct-charge refunds keep the pre-Phase-C behaviour.
   *
   * Note: Stripe processing fees are NOT refunded to the customer (Stripe
   * keeps them on the original charge). Platform absorbs that sliver.
   */
  isDestinationCharge?: boolean;
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
      ...(args.isDestinationCharge
        ? { reverse_transfer: true, refund_application_fee: true }
        : {}),
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
 * Retrieve a PaymentMethod's type (e.g. 'card', 'us_bank_account'). Used by
 * the `customer.updated` webhook to fill `payment_method_type` when syncing
 * a client's new default payment method (set via the Stripe Billing Portal,
 * DESIGN §6 failure recovery, M6 fix v0.29.x). No card-level detail is
 * fetched or stored, only the method-type string.
 */
export async function retrievePaymentMethodType(
  paymentMethodId: string,
): Promise<string | null> {
  if (dryRun()) return null;
  const client = getClient()!;
  const pm = await client.paymentMethods.retrieve(paymentMethodId);
  return pm.type;
}

/**
 * Read a customer's current default payment method straight from Stripe.
 * Belt-and-suspenders companion to the `customer.updated` webhook sync
 * (M6 fix, v0.29.x): called from the Billing Portal return route so the
 * saved PM is fresh even if the webhook hasn't landed yet (delivery lag,
 * or the client closes the tab before the event arrives).
 */
export interface CustomerDefaultPaymentMethod {
  paymentMethodId: string;
  paymentMethodType: string | null;
}

export async function getCustomerDefaultPaymentMethod(
  stripeCustomerId: string,
): Promise<CustomerDefaultPaymentMethod | null> {
  if (dryRun()) return null;
  const client = getClient()!;
  const customer = await client.customers.retrieve(stripeCustomerId, {
    expand: ['invoice_settings.default_payment_method'],
  });
  if (customer.deleted) return null;
  const pm = customer.invoice_settings?.default_payment_method;
  if (!pm) return null;
  if (typeof pm === 'string') {
    return { paymentMethodId: pm, paymentMethodType: await retrievePaymentMethodType(pm) };
  }
  return { paymentMethodId: pm.id, paymentMethodType: pm.type };
}

/**
 * Retrieve a Checkout Session - used by the success page to confirm payment.
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

/**
 * Reconciliation helper (deposit safety net, v0.29.x). Find the most recent
 * PAID deposit checkout session for a customer + retreat and return the
 * fields markDepositPaid needs. Returns null when no paid deposit session
 * exists yet (ACH still clearing, or the client never finished checkout).
 *
 * This mirrors exactly what the checkout.session.completed webhook derives,
 * so the cron / success-page / admin-reconcile paths all converge on the
 * same idempotent markDepositPaid call. It exists because the deposit flow
 * was previously 100% webhook-dependent: a single missed or never-delivered
 * event (or an async ACH event the old handler ignored) stranded the client
 * in `awaiting_deposit` forever even though Stripe had taken the money.
 */
export interface ReconciledDepositSession {
  paymentIntentId: string;
  chargeId?: string;
  paymentMethodId?: string;
  paymentMethodType?: string;
  amountCents: number;
}

export async function findPaidDepositSession(args: {
  stripeCustomerId: string;
  retreatId: string;
}): Promise<ReconciledDepositSession | null> {
  if (dryRun()) return null;
  const client = getClient()!;
  // Stripe returns sessions newest-first. 10 is generous: a retreat has at
  // most a handful of checkout attempts (card then ACH, retries on cancel).
  const sessions = await client.checkout.sessions.list({
    customer: args.stripeCustomerId,
    limit: 10,
  });
  const match = sessions.data.find(
    (s) =>
      s.payment_status === 'paid' &&
      s.metadata?.['payment_kind'] === 'deposit' &&
      s.metadata?.['retreat_id'] === args.retreatId,
  );
  if (!match) return null;

  const piId =
    typeof match.payment_intent === 'string'
      ? match.payment_intent
      : match.payment_intent?.id;
  if (!piId) return null;

  // Re-retrieve with expansion so payment_method + latest_charge resolve to
  // full objects (list-expand depth doesn't reach session sub-objects).
  const pi = await retrievePaymentIntent(piId);
  if (!pi) return null;

  let chargeId: string | undefined;
  if (typeof pi.latest_charge === 'string') chargeId = pi.latest_charge;
  else if (pi.latest_charge) chargeId = pi.latest_charge.id;

  let paymentMethodId: string | undefined;
  let paymentMethodType: string | undefined;
  if (typeof pi.payment_method === 'string') {
    paymentMethodId = pi.payment_method;
  } else if (pi.payment_method) {
    paymentMethodId = pi.payment_method.id;
    paymentMethodType = pi.payment_method.type;
  }

  return {
    paymentIntentId: pi.id,
    ...(chargeId ? { chargeId } : {}),
    ...(paymentMethodId ? { paymentMethodId } : {}),
    ...(paymentMethodType ? { paymentMethodType } : {}),
    amountCents: match.amount_total ?? pi.amount_received ?? pi.amount,
  };
}

export { StripePhiViolation };
