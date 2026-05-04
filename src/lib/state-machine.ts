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
 * All transitions are wired through M0–M8. `retryFailedCharge` is the
 * one cron-side orchestrator that lives outside the `transitions` object
 * because it composes Stripe + multiple transitions per call.
 */

import { randomUUID } from 'node:crypto';

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
  stripeCustomers,
} from '../db/schema.js';
import { buildIcs } from './ics.js';
import { notify } from './notifications.js';
import { log } from './phi-redactor.js';
import { chargeFinalBalance } from './stripe.js';

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
 * Public host for token-bearing client URLs.
 *
 * Production: PUBLIC_BASE_URL must be bound. Without it, every notify
 * email links to the dev *.run.app origin even from prod — bad for
 * client-facing URLs (M9 fix #45).
 *
 * Dev / non-prod: falls back to the dev *.run.app origin.
 */
function publicBaseUrl(): string {
  const url = process.env.PUBLIC_BASE_URL;
  if (url) return url;
  if (process.env.AUTH_ENABLED === '1') {
    // AUTH_ENABLED=1 is the prod tripwire — if we're enforcing auth,
    // we should also be on a real domain.
    throw new Error(
      'PUBLIC_BASE_URL is required when AUTH_ENABLED=1',
    );
  }
  return 'https://itr-client-hq-buejbopu5q-uc.a.run.app';
}

function adminBaseUrl(): string {
  return process.env.ADMIN_BASE_URL ?? publicBaseUrl();
}

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
    /** Saved PM id for the off-session final charge (M5).
     *  If omitted (legacy callers), the customer's default_payment_method_id
     *  is left untouched. */
    stripePaymentMethodId?: string;
    paymentMethodType?: string;
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
          // Match the partial unique index on payments_stripe_payment_intent_idx
          // which is `WHERE kind != 'refund'`. Refund rows reuse the original
          // PI legitimately and must NOT collide with the deposit/final upsert.
          targetWhere: sql`${payments.kind} <> 'refund'`,
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

      // Persist the saved payment method on stripe_customers so M5's
      // off-session charge has a PM id to reference. Idempotent (overwrites
      // with the latest value — Stripe attaches the PM at deposit time, and
      // any subsequent client card update flows through the same column).
      if (args.stripePaymentMethodId) {
        await tx
          .update(stripeCustomers)
          .set({
            defaultPaymentMethodId: args.stripePaymentMethodId,
            paymentMethodType: args.paymentMethodType ?? null,
            updatedAt: new Date(),
          })
          .where(eq(stripeCustomers.clientId, r.clientId));
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

      // Require an actual succeeded deposit payments row before scheduling
      // (M9 fix #14). Earlier code keyed on the `deposit_paid` audit_event,
      // which can drift from the payments table — money is the source of
      // truth, audit is just the trail.
      const [paid] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.retreatId, args.retreatId),
            eq(payments.kind, 'deposit'),
            eq(payments.status, 'succeeded'),
          ),
        )
        .limit(1);
      if (!paid) {
        throw new Error(
          'confirmDates: no succeeded deposit payment on file',
        );
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
  /**
   * in_progress → awaiting_final_charge.
   *
   * Therapist submits actual day counts at retreat completion. Recomputes
   * `total_actual_cents` from the snapshotted rates on the retreat row.
   * Idempotent: re-POST while already `awaiting_final_charge` with matching
   * day counts is a no-op.
   */
  async submitCompletion(args: {
    retreatId: RetreatId;
    actor: Actor;
    actualFullDays: number;
    actualHalfDays: number;
  }): Promise<void> {
    if (
      !Number.isInteger(args.actualFullDays) ||
      !Number.isInteger(args.actualHalfDays) ||
      args.actualFullDays < 0 ||
      args.actualHalfDays < 0 ||
      args.actualFullDays + args.actualHalfDays === 0
    ) {
      throw new Error('submitCompletion: invalid day counts');
    }

    const { db } = await getDb();

    const out = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(retreats).where(eq(retreats.id, args.retreatId));
      if (!r) throw new Error(`retreat not found: ${args.retreatId}`);

      // Idempotency: already submitted with same counts → no-op.
      if (r.state === 'awaiting_final_charge') {
        if (
          r.actualFullDays === args.actualFullDays &&
          r.actualHalfDays === args.actualHalfDays
        ) {
          return { changed: false, totalActualCents: r.totalActualCents ?? 0 };
        }
        throw new Error(
          'submitCompletion: completion already submitted with different day counts',
        );
      }
      assertTransition(r.state, 'awaiting_final_charge');

      if (args.actualHalfDays > 0 && r.halfDayRateCents == null) {
        throw new Error(
          'submitCompletion: half-days submitted but retreat has no half-day rate',
        );
      }

      const totalActualCents =
        r.fullDayRateCents * args.actualFullDays +
        (r.halfDayRateCents ?? 0) * args.actualHalfDays;

      await tx
        .update(retreats)
        .set({
          state: 'awaiting_final_charge',
          actualFullDays: args.actualFullDays,
          actualHalfDays: args.actualHalfDays,
          totalActualCents,
          updatedAt: new Date(),
        })
        .where(eq(retreats.id, args.retreatId));

      const { actorType, actorId } = actorToColumns(args.actor);
      await tx.insert(auditEvents).values({
        retreatId: args.retreatId,
        actorType,
        actorId,
        eventType: 'completion_submitted',
        payload: {
          actual_full_days: args.actualFullDays,
          actual_half_days: args.actualHalfDays,
          total_actual_cents: totalActualCents,
        },
      });
      return { changed: true, totalActualCents };
    });

    if (!out.changed) {
      log.info('state_transition_noop', {
        retreatId: args.retreatId,
        transition: 'submitCompletion',
      });
      return;
    }

    await notify({
      event: 'completion_submitted',
      retreatId: args.retreatId,
      adminUrl: `${adminBaseUrl()}/admin/clients/${args.retreatId}`,
    });

    log.info('state_transition', {
      retreatId: args.retreatId,
      to: 'awaiting_final_charge',
      totalActualCents: out.totalActualCents,
    });
  },

  /**
   * awaiting_final_charge → completed.
   *
   * Idempotent on `stripePaymentIntentId` (payments-row uniqueness). If the
   * retreat is already `completed`, only the payments row is updated and
   * we no-op on state + audit + notify. If we're recovering a previously
   * `final_charge_failed` retreat, the same path is taken and the `failed`
   * payments row gets flipped to `succeeded`.
   */
  async markCompleted(args: {
    retreatId: RetreatId;
    actor: Actor;
    stripePaymentIntentId: string;
    stripeChargeId?: string;
    amountCents: number;
  }): Promise<void> {
    const { db } = await getDb();

    const out = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(retreats).where(eq(retreats.id, args.retreatId));
      if (!r) throw new Error(`retreat not found: ${args.retreatId}`);

      const inserted = await tx
        .insert(payments)
        .values({
          retreatId: args.retreatId,
          kind: 'final',
          stripePaymentIntentId: args.stripePaymentIntentId,
          stripeChargeId: args.stripeChargeId ?? null,
          amountCents: args.amountCents,
          status: 'succeeded',
          attemptCount: 1,
          lastAttemptedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: payments.stripePaymentIntentId,
          // Match the partial unique index on payments_stripe_payment_intent_idx
          // which is `WHERE kind != 'refund'`. Refund rows reuse the original
          // PI legitimately and must NOT collide with the deposit/final upsert.
          targetWhere: sql`${payments.kind} <> 'refund'`,
          set: {
            status: 'succeeded',
            stripeChargeId: args.stripeChargeId ?? null,
            failureCode: null,
            failureMessage: null,
            updatedAt: new Date(),
            attemptCount: sql`${payments.attemptCount} + 1`,
            lastAttemptedAt: new Date(),
          },
        })
        .returning({ id: payments.id });
      const paymentRowIsNew = inserted.length > 0;

      if (r.state === 'completed') {
        return { changed: false, paymentRowIsNew };
      }
      assertTransition(r.state, 'completed');

      await tx
        .update(retreats)
        .set({ state: 'completed', updatedAt: new Date() })
        .where(eq(retreats.id, args.retreatId));

      const { actorType, actorId } = actorToColumns(args.actor);
      await tx.insert(auditEvents).values({
        retreatId: args.retreatId,
        actorType,
        actorId,
        eventType: 'final_charged',
        payload: {
          stripe_payment_intent_id: args.stripePaymentIntentId,
          amount_cents: args.amountCents,
        },
      });
      return { changed: true, paymentRowIsNew };
    });

    if (!out.changed) {
      log.info('state_transition_noop', {
        retreatId: args.retreatId,
        transition: 'markCompleted',
        paymentRowIsNew: out.paymentRowIsNew,
      });
      return;
    }

    await notify({
      event: 'final_charged',
      retreatId: args.retreatId,
      adminUrl: `${adminBaseUrl()}/admin/clients/${args.retreatId}`,
    });

    log.info('state_transition', {
      retreatId: args.retreatId,
      to: 'completed',
    });
  },

  /**
   * awaiting_final_charge → final_charge_failed.
   *
   * Records a failed final-charge attempt. Idempotent on
   * `stripePaymentIntentId` if provided; otherwise upserts a placeholder
   * row keyed on (retreat_id, kind='final') by inserting a fresh row and
   * relying on the caller (M6 retry) to use a fresh PI per attempt.
   *
   * For `requires_action` outcomes we go through this same path and stash
   * the client_secret in the payload so M6 can hand off the hosted-
   * confirmation flow.
   */
  async markFinalChargeFailed(args: {
    retreatId: RetreatId;
    actor: Actor;
    failureCode: string;
    failureMessage: string;
    stripePaymentIntentId?: string;
    amountCents?: number;
    /** Stripe PI client_secret — populated for `requires_action` only. */
    clientSecret?: string;
    /** Which attempt this failure represents (1 = first try, 2 = first
     *  retry, 3 = final retry). When `attempt === 3` the retry pool is
     *  exhausted and we additionally fire the `final_charge_retry_exhausted`
     *  escalation email. Defaults to 1. */
    attempt?: number;
  }): Promise<void> {
    const { db } = await getDb();

    await db.transaction(async (tx) => {
      const [r] = await tx.select().from(retreats).where(eq(retreats.id, args.retreatId));
      if (!r) throw new Error(`retreat not found: ${args.retreatId}`);

      // Idempotency: already in failed state — only update the payments row
      // (so retry attempts get their attempt_count bumped) and skip the
      // state/audit/notify side-effects.
      const alreadyFailed = r.state === 'final_charge_failed';
      if (!alreadyFailed) assertTransition(r.state, 'final_charge_failed');

      // ALWAYS write a payments row so the retry cron's attempt-count
      // derivation sees this failure (M9 fix #15). When the failure happened
      // before Stripe minted a PI (e.g. no_saved_payment_method short-circuit),
      // synthesize a sentinel PI so the unique index is satisfied without
      // conflicting with future real PIs. The sentinel is tagged so audit
      // queries can filter it out.
      const piId =
        args.stripePaymentIntentId ??
        `noPI:${args.retreatId}:${randomUUID()}`;
      await tx
        .insert(payments)
        .values({
          retreatId: args.retreatId,
          kind: 'final',
          stripePaymentIntentId: piId,
          amountCents: args.amountCents ?? 0,
          status: 'failed',
          failureCode: args.failureCode,
          failureMessage: args.failureMessage,
          attemptCount: 1,
          lastAttemptedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: payments.stripePaymentIntentId,
          // Match the partial unique index `WHERE kind != 'refund'`.
          targetWhere: sql`${payments.kind} <> 'refund'`,
          set: {
            status: 'failed',
            failureCode: args.failureCode,
            failureMessage: args.failureMessage,
            updatedAt: new Date(),
            attemptCount: sql`${payments.attemptCount} + 1`,
            lastAttemptedAt: new Date(),
          },
        });

      if (alreadyFailed) return;

      await tx
        .update(retreats)
        .set({ state: 'final_charge_failed', updatedAt: new Date() })
        .where(eq(retreats.id, args.retreatId));

      const { actorType, actorId } = actorToColumns(args.actor);
      await tx.insert(auditEvents).values({
        retreatId: args.retreatId,
        actorType,
        actorId,
        eventType: 'final_charge_failed',
        payload: {
          failure_code: args.failureCode,
          failure_message: args.failureMessage,
          stripe_payment_intent_id: args.stripePaymentIntentId ?? null,
          // client_secret is intentionally captured so M6 can hand off the
          // hosted-confirmation flow without round-tripping Stripe again.
          requires_action_client_secret: args.clientSecret ?? null,
        },
      });
    });

    await notify({
      event: 'final_charge_failed',
      retreatId: args.retreatId,
      adminUrl: `${adminBaseUrl()}/admin/clients/${args.retreatId}`,
    });

    if ((args.attempt ?? 1) >= 3) {
      await notify({
        event: 'final_charge_retry_exhausted',
        retreatId: args.retreatId,
        adminUrl: `${adminBaseUrl()}/admin/clients/${args.retreatId}`,
      });
    }

    log.info('state_transition', {
      retreatId: args.retreatId,
      to: 'final_charge_failed',
      failureCode: args.failureCode,
      attempt: args.attempt ?? 1,
    });
  },
} as const;

/**
 * One retry pass over a single `final_charge_failed` retreat (M6).
 *
 *   - Looks up the retreat, verifies state.
 *   - Computes the remaining balance (total_actual - sum of succeeded payments).
 *   - Counts prior failed final-kind payments to derive the next attempt #.
 *   - Caps at 3 total attempts (1 initial + 2 retries).
 *   - Calls `chargeFinalBalance` with idempotency key `final:<retreatId>:<N>`.
 *   - Success path → `markCompleted`.
 *   - Failure path → `markFinalChargeFailed` (with `attempt=N` so the
 *     transition fires the exhaustion notify when N reaches 3).
 *
 * The cron route is the only intended caller. Returns a small status
 * object so the caller can aggregate counts.
 */
export type RetryOutcome =
  | 'succeeded'
  | 'failed_will_retry'
  | 'failed_exhausted'
  | 'skipped_no_pm'
  | 'skipped_zero_balance'
  | 'skipped_max_attempts'
  | 'skipped_concurrent';

export async function retryFailedCharge(args: {
  retreatId: string;
  actor: Actor;
}): Promise<{ outcome: RetryOutcome; attempt: number }> {
  const { db, pool } = await getDb();

  // Advisory lock keyed on the retreat id (M9 fix #2). Prevents two
  // concurrent retry passes (cron + manual fire, two cron retries) from
  // racing on the same retreat. We hold the lock across the entire
  // function on a dedicated pool client; the lock auto-releases when
  // the client is released, even on uncaught throw.
  const client = await pool.connect();
  // 32-bit signed key derived from the retreat id; collision space is
  // small but a random false-positive only delays one retry by a day.
  const key = retreatIdToLockKey(args.retreatId);
  const acquired = await client.query<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS pg_try_advisory_lock',
    [key],
  );
  if (!acquired.rows[0]?.pg_try_advisory_lock) {
    client.release();
    log.info('retry_failed_charge_concurrent_skipped', {
      retreatId: args.retreatId,
    });
    return { outcome: 'skipped_concurrent', attempt: 0 };
  }
  try {
    return await runRetry(args);
  } finally {
    // Audit tier-9: a failed unlock leaves the session-scoped lock held
    // until the pg connection is physically closed (NOT when client.release()
    // returns it to the pool — pool reuses the same session). A leaked
    // lock would silently block subsequent retry runs for this retreat.
    // Log loudly so ops can drain/cycle the pool if it ever happens.
    await client
      .query('SELECT pg_advisory_unlock($1)', [key])
      .catch((err: unknown) => {
        log.warn('retry_advisory_unlock_failed', {
          retreatId: args.retreatId,
          error: (err as Error).message,
        });
      });
    client.release();
  }
}

function retreatIdToLockKey(retreatId: string): number {
  // Stable 32-bit signed hash. Same approach as Postgres `hashtext()`
  // would be fine, but cheap to compute client-side.
  let h = 0;
  for (let i = 0; i < retreatId.length; i++) {
    h = (h * 31 + retreatId.charCodeAt(i)) | 0;
  }
  return h;
}

async function runRetry(args: {
  retreatId: string;
  actor: Actor;
}): Promise<{ outcome: RetryOutcome; attempt: number }> {
  const { db } = await getDb();
  const [r] = await db.select().from(retreats).where(eq(retreats.id, args.retreatId));
  if (!r) throw new Error(`retreat not found: ${args.retreatId}`);
  if (r.state !== 'final_charge_failed') {
    throw new Error(
      `retryFailedCharge: retreat state is ${r.state}, expected final_charge_failed`,
    );
  }
  if (r.totalActualCents == null) {
    throw new Error('retryFailedCharge: total_actual_cents is null');
  }

  // Read prior final-kind payments. Attempt cap counts only non-succeeded
  // rows (M9 fix #16) — a succeeded row means the charge already cleared,
  // so there's no reason to count it against the 3-attempt budget.
  const priorRows = await db
    .select({
      id: payments.id,
      status: payments.status,
      amountCents: payments.amountCents,
    })
    .from(payments)
    .where(and(eq(payments.retreatId, args.retreatId), eq(payments.kind, 'final')));
  const priorFailedAttempts = priorRows.filter(
    (p) => p.status !== 'succeeded',
  ).length;
  const succeededFinalCents = priorRows
    .filter((p) => p.status === 'succeeded')
    .reduce((acc, p) => acc + p.amountCents, 0);
  const succeededDepositCents = (
    await db
      .select({ amountCents: payments.amountCents })
      .from(payments)
      .where(
        and(
          eq(payments.retreatId, args.retreatId),
          eq(payments.kind, 'deposit'),
          eq(payments.status, 'succeeded'),
        ),
      )
  ).reduce((acc, p) => acc + p.amountCents, 0);

  if (priorFailedAttempts >= 3) {
    return { outcome: 'skipped_max_attempts', attempt: priorFailedAttempts };
  }
  const attempt = priorFailedAttempts + 1;

  const balance =
    r.totalActualCents - succeededDepositCents - succeededFinalCents;
  if (balance <= 0) {
    // Should not happen when state is final_charge_failed, but defend.
    return { outcome: 'skipped_zero_balance', attempt };
  }

  const [sc] = await db
    .select({
      stripeCustomerId: stripeCustomers.stripeCustomerId,
      defaultPaymentMethodId: stripeCustomers.defaultPaymentMethodId,
    })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.clientId, r.clientId));

  if (!sc || !sc.defaultPaymentMethodId) {
    log.warn('retry_failed_charge_no_pm', { retreatId: args.retreatId, attempt });
    await transitions.markFinalChargeFailed({
      retreatId: args.retreatId,
      actor: args.actor,
      failureCode: 'no_saved_payment_method',
      failureMessage:
        'no saved payment method on stripe_customers — cannot off-session charge',
      attempt,
    });
    return {
      outcome: attempt >= 3 ? 'failed_exhausted' : 'skipped_no_pm',
      attempt,
    };
  }

  const charge = await chargeFinalBalance({
    retreatId: args.retreatId,
    clientId: r.clientId,
    stripeCustomerId: sc.stripeCustomerId,
    paymentMethodId: sc.defaultPaymentMethodId,
    amountCents: balance,
    idempotencyKey: `final:${args.retreatId}:${attempt}`,
  });

  if (charge.status === 'succeeded') {
    log.info('retry_final_charge_db_write_starting', {
      retreatId: args.retreatId,
      paymentIntentId: charge.paymentIntentId,
      amountCents: balance,
      attempt,
    });
    try {
      await transitions.markCompleted({
        retreatId: args.retreatId,
        actor: args.actor,
        stripePaymentIntentId: charge.paymentIntentId,
        ...(charge.chargeId ? { stripeChargeId: charge.chargeId } : {}),
        amountCents: balance,
      });
    } catch (err) {
      log.error('CRITICAL_final_charge_succeeded_but_db_write_failed', {
        retreatId: args.retreatId,
        paymentIntentId: charge.paymentIntentId,
        amountCents: balance,
        attempt,
        error: (err as Error).message,
      });
      throw err;
    }
    return { outcome: 'succeeded', attempt };
  }

  await transitions.markFinalChargeFailed({
    retreatId: args.retreatId,
    actor: args.actor,
    failureCode: charge.failureCode ?? 'unknown',
    failureMessage: charge.failureMessage ?? '',
    ...(charge.paymentIntentId
      ? { stripePaymentIntentId: charge.paymentIntentId }
      : {}),
    amountCents: balance,
    ...(charge.clientSecret ? { clientSecret: charge.clientSecret } : {}),
    attempt,
  });
  return {
    outcome: attempt >= 3 ? 'failed_exhausted' : 'failed_will_retry',
    attempt,
  };
}

