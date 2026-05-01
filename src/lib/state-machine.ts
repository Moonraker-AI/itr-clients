/**
 * Retreat state machine — the spine of the system (DESIGN.md §5).
 *
 * Every state mutation MUST go through a transition function in this module.
 * Each transition validates the source state, performs side effects in later
 * milestones (DB write, Stripe call, email send), writes an audit_event, and
 * fires notifications. M1 ships the skeleton + the transition graph; bodies
 * are filled in M2+ as the dependent tables and integrations land.
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
 */

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

/**
 * Transition stubs. Bodies land per milestone:
 *   - sendConsentPackage: M2 (consent + Gmail)
 *   - markConsentsSigned: M2
 *   - markDepositPaid:   M3 (Stripe webhook)
 *   - confirmDates:      M4
 *   - markInProgress:    M4 cron
 *   - submitCompletion:  M5
 *   - markCompleted:     M5
 *   - markFinalChargeFailed / recoverFinalCharge: M6
 *   - cancel: M2+ (allowed from any pre-completed state)
 *
 * The shape is identical: ({ retreatId, actor, ...input }) → Promise<void>.
 * Each will (1) load retreat + assertTransition, (2) run side effects, (3)
 * write the audit event, (4) notify(event_type, retreat_id), all in a single
 * transaction where the DB write is the commit point.
 */
type RetreatId = string;
type Actor =
  | { kind: 'therapist'; id: string }
  | { kind: 'client'; token: string }
  | { kind: 'system' }
  | { kind: 'stripe'; eventId: string };

const NOT_IMPLEMENTED = (where: string) => {
  throw new Error(`state-machine: ${where} not implemented yet`);
};

export const transitions = {
  sendConsentPackage(_args: { retreatId: RetreatId; actor: Actor }) {
    NOT_IMPLEMENTED('sendConsentPackage');
  },
  markConsentsSigned(_args: { retreatId: RetreatId; actor: Actor }) {
    NOT_IMPLEMENTED('markConsentsSigned');
  },
  markDepositPaid(_args: {
    retreatId: RetreatId;
    actor: Actor;
    paymentIntentId: string;
  }) {
    NOT_IMPLEMENTED('markDepositPaid');
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
  cancel(_args: { retreatId: RetreatId; actor: Actor; reason?: string }) {
    NOT_IMPLEMENTED('cancel');
  },
} as const;
