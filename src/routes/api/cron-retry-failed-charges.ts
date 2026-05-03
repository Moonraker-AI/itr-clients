/**
 * /api/cron/retry-failed-charges — Cloud Scheduler target (DESIGN.md §10, M6).
 *
 * Behaviour:
 *   - Selects retreats with `state='final_charge_failed'`.
 *   - For each, gates on the most recent `payments` row's `last_attempted_at`:
 *       attempt 1 (initial fail) → wait 24h before attempt 2.
 *       attempt 2 (one retry done) → wait 72h before attempt 3.
 *       attempt 3+ → no further retries, escalation already fired.
 *   - Calls `retryFailedCharge(retreatId)` which orchestrates the full
 *     compute-balance → chargeFinalBalance → markCompleted/markFinalChargeFailed
 *     dance with idempotency key `final:<retreatId>:<N>`.
 *
 * Auth: same OIDC + optional `CRON_SHARED_SECRET` model as the
 * state-transitions cron.
 *
 * No PHI in response or logs.
 */

import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { payments, retreats } from '../../db/schema.js';
import { log } from '../../lib/phi-redactor.js';
import { retryFailedCharge } from '../../lib/state-machine.js';

export const cronRetryFailedChargesRoute = new Hono();

const MS_24H = 24 * 60 * 60 * 1000;
const MS_72H = 72 * 60 * 60 * 1000;

cronRetryFailedChargesRoute.post('/retry-failed-charges', async (c) => {
  const expected = process.env.CRON_SHARED_SECRET;
  if (expected) {
    const got = c.req.header('x-cron-secret');
    if (got !== expected) {
      log.warn('cron_retry_failed_charges_unauthorized', {});
      return c.json({ error: 'unauthorized' }, 401);
    }
  }

  const { db } = await getDb();
  const candidates = await db
    .select({ id: retreats.id })
    .from(retreats)
    .where(eq(retreats.state, 'final_charge_failed'));

  let attempted = 0;
  let succeeded = 0;
  let failedWillRetry = 0;
  let failedExhausted = 0;
  let skippedTooSoon = 0;
  const errors: { retreatId: string; error: string }[] = [];
  const now = Date.now();

  for (const r of candidates) {
    // Decide eligibility based on the most-recent final-kind payments row.
    const [latest] = await db
      .select({
        status: payments.status,
        lastAttemptedAt: payments.lastAttemptedAt,
      })
      .from(payments)
      .where(
        and(eq(payments.retreatId, r.id), eq(payments.kind, 'final')),
      )
      .orderBy(desc(payments.lastAttemptedAt))
      .limit(1);

    const finalRows = await db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.retreatId, r.id), eq(payments.kind, 'final')));
    const priorAttempts = finalRows.length;
    if (priorAttempts >= 3) {
      // Already exhausted; cron is a no-op for this retreat.
      continue;
    }
    if (!latest?.lastAttemptedAt) {
      // No prior attempt timestamp → don't auto-retry; admin/UI path
      // will have created the first attempt.
      skippedTooSoon += 1;
      continue;
    }
    const elapsed = now - latest.lastAttemptedAt.getTime();
    const requiredWait = priorAttempts === 1 ? MS_24H : MS_72H;
    if (elapsed < requiredWait) {
      skippedTooSoon += 1;
      continue;
    }

    attempted += 1;
    try {
      const out = await retryFailedCharge({
        retreatId: r.id,
        actor: { kind: 'system' },
      });
      switch (out.outcome) {
        case 'succeeded':
          succeeded += 1;
          break;
        case 'failed_will_retry':
        case 'skipped_no_pm':
          failedWillRetry += 1;
          break;
        case 'failed_exhausted':
          failedExhausted += 1;
          break;
        case 'skipped_zero_balance':
        case 'skipped_max_attempts':
          // Don't count toward the retry tallies.
          break;
      }
    } catch (err) {
      const error = (err as Error).message;
      log.error('cron_retry_failed_charge_error', { retreatId: r.id, error });
      errors.push({ retreatId: r.id, error });
    }
  }

  log.info('cron_retry_failed_charges_run', {
    candidates: candidates.length,
    attempted,
    succeeded,
    failedWillRetry,
    failedExhausted,
    skippedTooSoon,
    errorCount: errors.length,
  });

  return c.json({
    candidates: candidates.length,
    attempted,
    succeeded,
    failedWillRetry,
    failedExhausted,
    skippedTooSoon,
    errors,
  });
});
