/**
 * Retreat state machine — the spine of the system (DESIGN.md §5).
 *
 * Every state mutation MUST go through a transition function in this module.
 * Each transition validates the source state, performs side effects, writes
 * an `audit_event`, and fires notifications.
 *
 *   draft
 *     → awaiting_consents
 *       → awaiting_deposit
 *         → scheduled
 *           → in_progress
 *             → awaiting_final_charge
 *               → completed
 *               ↘ final_charge_failed → completed   (via recovery)
 *     ↘ cancelled (any time before completed)
 *
 * As of M2 phase 2: `sendConsentPackage`, `markConsentsSigned`, `cancel`
 * are wired. Stripe + scheduling transitions land in M3+ (still throw).
 */

import { and, eq, sql } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import {
  auditEvents,
  clients,
  consentSignatures,
  consentTemplates,
  payments,
  retreatRequiredConsents,
  retreats,
} from '../db/schema.js';
import { notify } from './notifications.js';
import { log } from './phi-redactor.js';

export const RETREAT_STATES = [
  'draft',
  'awaiting_consents',
  'awaiting_deposit',
  'scheduled',
  'in_progress',
  'awaiting_final_charge',
  'completed',
  'final_charge_failed',
  'cancelled',
] as const;

export type RetreatState = (typeof RETREAT_STATES)[number];

const ALLOWED: Record<RetreatState, readonly RetreatState[]> = {
  draft: ['awaiting_consents', 'cancelled'],
  awaiting_consents: ['awaiting_deposit', 'cancelled'],
  awaiting_deposit: ['scheduled', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['awaiting_final_charge', 'cancelled'],
  awaiting_final_charge: ['completed', 'final_charge_failed', 'cancelled'],
  final_charge_failed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: RetreatState,
    public readonly to: RetreatState,
  ) {
    super(`illegal retreat transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: RetreatState, to: RetreatState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(
  from: RetreatState,
  to: RetreatState,
): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

type RetreatId = string;
export type Actor =
  | { kind: 'therapist'; id: string }
  | { kind: 'client'; token: string }
  | { kind: 'system' }
  | { kind: 'stripe'; eventId: string };

function actorToColumns(a: Actor): { actorType: 'therapist' | 'client' | 'system' | 'stripe'; actorId: string | null } {
  switch (a.kind) {
    case 'therapist':
      return { actorType: 'therapist', actorId: a.id };
    case 'client':
      return { actorType: 'client', actorId: a.token };
    case 'system':
      return { actorType: 'system', actorId: null };
    case 'stripe':
      return { actorType: 'stripe', actorId: a.eventId };
  }
}

/**
 * Public host for token-bearing client URLs. Cloud Run sets `K_SERVICE` and
 * the workflow injects `PUBLIC_BASE_URL` once a custom domain is wired up;
 * fall back to the *.run.app origin while we're still on the default URL.
 */
function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_BASE_URL ??
    'https://itr-client-hq-buejbopu5q-uc.a.run.app'
  );
}

function adminBaseUrl(): string {
  return process.env.ADMIN_BASE_URL ?? publicBaseUrl();
}

const NOT_IMPLEMENTED = (where: string) => {
  throw new Error(`state-machine: ${where} not implemented yet`);
};

export const transitions = {
  /**
   * draft → awaiting_consents.
   *
   * Caller (admin form) must already have inserted the retreat row in
   * `draft` and seeded `retreat_required_consents` with the snapshotted
   * template versions. This function:
   *   - validates the transition
   *   - flips `retreats.state`
   *   - writes audit_event
   *   - emails the client + team@ via notify()
   */
  async sendConsentPackage(args: {
    retreatId: RetreatId;
    actor: Actor;
  }): Promise<void> {
    const { db } = await getDb();

    const result = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(retreats).where(eq(retreats.id, args.retreatId));
      if (!r) throw new Error(`retreat not found: ${args.retreatId}`);
      assertTransition(r.state, 'awaiting_consents');

      const required = await tx
        .select({ templateId: retreatRequiredConsents.templateId })
        .from(retreatRequiredConsents)
        .where(eq(retreatRequiredConsents.retreatId, args.retreatId));
      if (required.length === 0) {
        throw new Error('retreat has no required consents — admin form must seed them');
      }

      await tx
        .update(retreats)
        .set({ state: 'awaiting_consents', updatedAt: new Date() })
        .where(eq(retreats.id, args.retreatId));

      const { actorType, actorId } = actorToColumns(args.actor);
      await tx.insert(auditEvents).values({
        retreatId: args.retreatId,
        actorType,
        actorId,
        eventType: 'consent_package_sent',
        payload: { required_template_count: required.length },
      });

      return { client_token: r.clientToken, client_id: r.clientId };
    });

    const [client] = await db
      .select({ email: clients.email, firstName: clients.firstName })
      .from(clients)
      .where(eq(clients.id, result.client_id));
    if (!client) throw new Error(`client row missing for retreat ${args.retreatId}`);

    await notify({
      event: 'consent_package_sent',
      retreatId: args.retreatId,
      clientEmail: client.email,
      clientFirstName: client.firstName,
      clientPortalUrl: `${publicBaseUrl()}/c/${result.client_token}/consents`,
    });

    log.info('state_transition', {
      retreatId: args.retreatId,
      to: 'awaiting_consents',
    });
  },

  /**
   * awaiting_consents → awaiting_deposit.
   *
   * Called by the public sign route once the last required signature lands.
   * Validates that every `retreat_required_consents` row whose template
   * `requires_signature=true` has at least one `consent_signatures` row.
   */
  async markConsentsSigned(args: {
    retreatId: RetreatId;
    actor: Actor;
  }): Promise<void> {
    const { db } = await getDb();

    await db.transaction(async (tx) => {
      const [r] = await tx.select().from(retreats).where(eq(retreats.id, args.retreatId));
      if (!r) throw new Error(`retreat not found: ${args.retreatId}`);
      assertTransition(r.state, 'awaiting_deposit');

      const required = await tx
        .select({
          templateId: retreatRequiredConsents.templateId,
          requiresSignature: consentTemplates.requiresSignature,
        })
        .from(retreatRequiredConsents)
        .innerJoin(
          consentTemplates,
          eq(retreatRequiredConsents.templateId, consentTemplates.id),
        )
        .where(eq(retreatRequiredConsents.retreatId, args.retreatId));

      const signedTemplateIds = new Set(
        (
          await tx
            .select({ templateId: consentSignatures.templateId })
            .from(consentSignatures)
            .where(eq(consentSignatures.retreatId, args.retreatId))
        ).map((s) => s.templateId),
      );

      const missing = required
        .filter((r) => r.requiresSignature && !signedTemplateIds.has(r.templateId))
        .map((r) => r.templateId);
      if (missing.length > 0) {
        throw new Error(`required signatures missing: ${missing.join(', ')}`);
      }

      await tx
        .update(retreats)
        .set({ state: 'awaiting_deposit', updatedAt: new Date() })
        .where(eq(retreats.id, args.retreatId));

      const { actorType, actorId } = actorToColumns(args.actor);
      await tx.insert(auditEvents).values({
        retreatId: args.retreatId,
        actorType,
        actorId,
        eventType: 'consents_signed',
        payload: { required_count: required.length },
      });
    });

    await notify({
      event: 'consents_signed',
      retreatId: args.retreatId,
      adminUrl: `${adminBaseUrl()}/admin/clients/${args.retreatId}`,
    });

    log.info('state_transition', {
      retreatId: args.retreatId,
      to: 'awaiting_deposit',
    });
  },

  /**
   * <any pre-completed state> → cancelled. Reason is stored on the audit
   * event payload; client-facing copy is intentionally generic.
   */
  async cancel(args: {
    retreatId: RetreatId;
    actor: Actor;
    reason?: string;
  }): Promise<void> {
    const { db } = await getDb();

    await db.transaction(async (tx) => {
      const [r] = await tx.select().from(retreats).where(eq(retreats.id, args.retreatId));
      if (!r) throw new Error(`retreat not found: ${args.retreatId}`);
      assertTransition(r.state, 'cancelled');

      await tx
        .update(retreats)
        .set({ state: 'cancelled', updatedAt: new Date() })
        .where(eq(retreats.id, args.retreatId));

      const { actorType, actorId } = actorToColumns(args.actor);
      await tx.insert(auditEvents).values({
        retreatId: args.retreatId,
        actorType,
        actorId,
        eventType: 'cancelled',
        payload: args.reason ? { reason: args.reason } : {},
      });
    });

    await notify({
      event: 'cancelled',
      retreatId: args.retreatId,
      adminUrl: `${adminBaseUrl()}/admin/clients/${args.retreatId}`,
    });

    log.info('state_transition', {
      retreatId: args.retreatId,
      to: 'cancelled',
    });
  },

  /**
   * Records a successful deposit payment. Called from the Stripe webhook
   * handler on `checkout.session.completed` (deposit) or
   * `payment_intent.succeeded` for the deposit kind.
   *
   * Idempotent on `stripePaymentIntentId` — duplicate webhook deliveries
   * are absorbed silently.
   *
   * NOTE: this does NOT change `retreats.state`. The state stays at
   * `awaiting_deposit` until `confirmDates` (M4) flips it to `scheduled`
   * — the design's "scheduled" precondition is BOTH deposit paid AND
   * dates confirmed (DESIGN §5).
   */
  async markDepositPaid(args: {
    retreatId: RetreatId;
    actor: Actor;
    stripePaymentIntentId: string;
    stripeChargeId?: string;
    amountCents: number;
  }): Promise<void> {
    const { db } = await getDb();

    const upserted = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(retreats).where(eq(retreats.id, args.retreatId));
      if (!r) throw new Error(`retreat not found: ${args.retreatId}`);
      // No assertTransition: this writes a payment + audit but does not
      // touch state. State transition graph is unchanged.

      const inserted = await tx
        .insert(payments)
        .values({
          retreatId: args.retreatId,
          kind: 'deposit',
          stripePaymentIntentId: args.stripePaymentIntentId,
          stripeChargeId: args.stripeChargeId ?? null,
          amountCents: args.amountCents,
          status: 'succeeded',
          attemptCount: 1,
          lastAttemptedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: payments.stripePaymentIntentId,
          set: {
            status: 'succeeded',
            stripeChargeId: args.stripeChargeId ?? null,
            updatedAt: new Date(),
            attemptCount: sql`${payments.attemptCount} + 1`,
            lastAttemptedAt: new Date(),
          },
        })
        .returning({ id: payments.id });

      const isNew = inserted.length > 0;
      const { actorType, actorId } = actorToColumns(args.actor);
      if (isNew) {
        await tx.insert(auditEvents).values({
          retreatId: args.retreatId,
          actorType,
          actorId,
          eventType: 'deposit_paid',
          payload: {
            stripe_payment_intent_id: args.stripePaymentIntentId,
            amount_cents: args.amountCents,
          },
        });
      }
      return { isNew };
    });

    if (upserted.isNew) {
      await notify({
        event: 'deposit_paid',
        retreatId: args.retreatId,
        adminUrl: `${adminBaseUrl()}/admin/clients/${args.retreatId}`,
      });
    }

    log.info('payment_recorded', {
      retreatId: args.retreatId,
      kind: 'deposit',
      stripePaymentIntentId: args.stripePaymentIntentId,
      isNew: upserted.isNew,
    });
  },
  confirmDates(_args: {
    retreatId: RetreatId;
    actor: Actor;
    startDate: string;
    endDate: string;
  }) {
    NOT_IMPLEMENTED('confirmDates');
  },
  markInProgress(_args: { retreatId: RetreatId; actor: Actor }) {
    NOT_IMPLEMENTED('markInProgress');
  },
  submitCompletion(_args: {
    retreatId: RetreatId;
    actor: Actor;
    actualFullDays: number;
    actualHalfDays: number;
  }) {
    NOT_IMPLEMENTED('submitCompletion');
  },
  markCompleted(_args: {
    retreatId: RetreatId;
    actor: Actor;
    paymentIntentId: string;
  }) {
    NOT_IMPLEMENTED('markCompleted');
  },
  markFinalChargeFailed(_args: {
    retreatId: RetreatId;
    actor: Actor;
    failureCode: string;
    failureMessage: string;
  }) {
    NOT_IMPLEMENTED('markFinalChargeFailed');
  },
} as const;

