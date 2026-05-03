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
import { buildIcs } from './ics.js';
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function inclusiveDayCount(startIso: string, endIso: string): number {
  const start = Date.UTC(
    Number(startIso.slice(0, 4)),
    Number(startIso.slice(5, 7)) - 1,
    Number(startIso.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(endIso.slice(0, 4)),
    Number(endIso.slice(5, 7)) - 1,
    Number(endIso.slice(8, 10)),
  );
  return Math.round((end - start) / 86_400_000) + 1;
}

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
  /**
   * awaiting_deposit → scheduled.
   *
   * Therapist confirms calendar dates after deposit has cleared. Requires
   * a `deposit_paid` audit_event on the retreat (DESIGN §5: scheduled
   * precondition is BOTH deposit-paid AND dates-confirmed).
   *
   * Idempotent: re-POST with the same dates while already `scheduled`
   * is a no-op. Re-POST with different dates while `scheduled` errors —
   * date changes after confirmation are out of scope (would need an
   * explicit reschedule transition).
   */
  async confirmDates(args: {
    retreatId: RetreatId;
    actor: Actor;
    startDate: string;
    endDate: string;
  }): Promise<void> {
    if (!ISO_DATE_RE.test(args.startDate) || !ISO_DATE_RE.test(args.endDate)) {
      throw new Error('confirmDates: dates must be YYYY-MM-DD');
    }
    if (args.endDate < args.startDate) {
      throw new Error('confirmDates: endDate must be >= startDate');
    }

    const { db } = await getDb();

    const out = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(retreats).where(eq(retreats.id, args.retreatId));
      if (!r) throw new Error(`retreat not found: ${args.retreatId}`);

      // Idempotency: already scheduled with the same dates → no-op.
      if (r.state === 'scheduled') {
        if (
          r.scheduledStartDate === args.startDate &&
          r.scheduledEndDate === args.endDate
        ) {
          return { changed: false };
        }
        throw new Error(
          'confirmDates: retreat already scheduled with different dates',
        );
      }
      assertTransition(r.state, 'scheduled');

      // Span check: inclusive calendar days vs. plannedFullDays + plannedHalfDays/2.
      const span = inclusiveDayCount(args.startDate, args.endDate);
      const planned = r.plannedFullDays + r.plannedHalfDays / 2;
      if (Math.abs(span - planned) > 1) {
        throw new Error(
          `confirmDates: span ${span}d does not match planned ${planned}d (tolerance ±1)`,
        );
      }

      // Require deposit_paid audit_event before scheduling.
      const [paid] = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.retreatId, args.retreatId),
            eq(auditEvents.eventType, 'deposit_paid'),
          ),
        )
        .limit(1);
      if (!paid) {
        throw new Error('confirmDates: deposit_paid audit_event missing');
      }

      await tx
        .update(retreats)
        .set({
          state: 'scheduled',
          scheduledStartDate: args.startDate,
          scheduledEndDate: args.endDate,
          updatedAt: new Date(),
        })
        .where(eq(retreats.id, args.retreatId));

      const { actorType, actorId } = actorToColumns(args.actor);
      await tx.insert(auditEvents).values({
        retreatId: args.retreatId,
        actorType,
        actorId,
        eventType: 'dates_confirmed',
        payload: {
          start_date: args.startDate,
          end_date: args.endDate,
          span_days: span,
        },
      });
      return { changed: true };
    });

    if (!out.changed) {
      log.info('state_transition_noop', {
        retreatId: args.retreatId,
        transition: 'confirmDates',
      });
      return;
    }

    const ics = buildIcs({
      uid: args.retreatId,
      startDate: args.startDate,
      endDate: args.endDate,
      summary: 'ITR retreat',
    });

    await notify({
      event: 'dates_confirmed',
      retreatId: args.retreatId,
      adminUrl: `${adminBaseUrl()}/admin/clients/${args.retreatId}`,
      attachments: [
        {
          filename: 'retreat.ics',
          mimeType: 'text/calendar; method=PUBLISH; charset=UTF-8',
          content: ics,
        },
      ],
    });

    log.info('state_transition', {
      retreatId: args.retreatId,
      to: 'scheduled',
    });
  },

  /**
   * scheduled → in_progress.
   *
   * Driven by the `/api/cron/state-transitions` Cloud Scheduler job on
   * each retreat's `scheduled_start_date`. Idempotent: callers that
   * pass an already-in-progress retreat get a no-op.
   */
  async markInProgress(args: {
    retreatId: RetreatId;
    actor: Actor;
  }): Promise<void> {
    const { db } = await getDb();

    const out = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(retreats).where(eq(retreats.id, args.retreatId));
      if (!r) throw new Error(`retreat not found: ${args.retreatId}`);
      if (r.state === 'in_progress') return { changed: false };
      assertTransition(r.state, 'in_progress');

      await tx
        .update(retreats)
        .set({ state: 'in_progress', updatedAt: new Date() })
        .where(eq(retreats.id, args.retreatId));

      const { actorType, actorId } = actorToColumns(args.actor);
      await tx.insert(auditEvents).values({
        retreatId: args.retreatId,
        actorType,
        actorId,
        eventType: 'in_progress',
        payload: {},
      });
      return { changed: true };
    });

    if (!out.changed) {
      log.info('state_transition_noop', {
        retreatId: args.retreatId,
        transition: 'markInProgress',
      });
      return;
    }

    await notify({
      event: 'in_progress',
      retreatId: args.retreatId,
      adminUrl: `${adminBaseUrl()}/admin/clients/${args.retreatId}`,
    });

    log.info('state_transition', {
      retreatId: args.retreatId,
      to: 'in_progress',
    });
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

