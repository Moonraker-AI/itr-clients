/**
 * /api/cron/reconcile-deposits - Cloud Scheduler target (deposit safety net).
 *
 * The deposit flow was 100% webhook-dependent: if a `checkout.session.*`
 * event was never delivered (Stripe endpoint misconfig, transient 5xx past
 * Stripe's retry window) or arrived for an ACH payment that only cleared
 * days later, the retreat sat in `awaiting_deposit` forever even though
 * Stripe had the money. This cron closes that gap.
 *
 * Behaviour:
 *   - Selects every retreat in `state='awaiting_deposit'`.
 *   - For each, calls reconcileDepositForRetreat, which asks Stripe whether
 *     a PAID deposit checkout session exists for that client + retreat and,
 *     if so, runs the same idempotent markDepositPaid the webhook would.
 *   - A retreat with no Stripe customer (never started checkout) or no paid
 *     session (still awaiting / ACH still clearing) is a no-op.
 *
 * Auth: same OIDC + CRON_SHARED_SECRET model as the other crons.
 * No PHI in response or logs (retreat ids + counts only).
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { retreats } from '../../db/schema.js';
import { verifyCronSecret } from '../../lib/cron-auth.js';
import { log } from '../../lib/phi-redactor.js';
import { reconcileDepositForRetreat } from '../../lib/state-machine.js';

export const cronReconcileDepositsRoute = new Hono();

cronReconcileDepositsRoute.post('/reconcile-deposits', async (c) => {
  if (!verifyCronSecret(c)) {
    log.warn('cron_reconcile_deposits_unauthorized', {});
    return c.json({ error: 'unauthorized' }, 401);
  }

  const { db } = await getDb();
  const candidates = await db
    .select({ id: retreats.id })
    .from(retreats)
    .where(eq(retreats.state, 'awaiting_deposit'));

  let reconciled = 0;
  let stillAwaiting = 0;
  let noCustomer = 0;
  const errors: { retreatId: string; error: string }[] = [];

  for (const r of candidates) {
    try {
      const out = await reconcileDepositForRetreat(r.id, { kind: 'system' });
      switch (out.outcome) {
        case 'reconciled':
          reconciled += 1;
          break;
        case 'no_customer':
          noCustomer += 1;
          break;
        case 'no_paid_session':
        case 'already_recorded':
        case 'retreat_not_found':
          stillAwaiting += 1;
          break;
      }
    } catch (err) {
      const error = (err as Error).message;
      log.error('cron_reconcile_deposit_error', { retreatId: r.id, error });
      errors.push({ retreatId: r.id, error });
    }
  }

  log.info('cron_reconcile_deposits_run', {
    candidates: candidates.length,
    reconciled,
    stillAwaiting,
    noCustomer,
    errorCount: errors.length,
  });

  return c.json({
    candidates: candidates.length,
    reconciled,
    stillAwaiting,
    noCustomer,
    errors,
  });
});
