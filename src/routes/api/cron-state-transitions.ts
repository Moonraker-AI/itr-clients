/**
 * /api/cron/state-transitions — Cloud Scheduler target (DESIGN.md §10).
 *
 * Auth model:
 *   - Cloud Scheduler is configured with an OIDC token addressed at the
 *     runtime SA. Cloud Run's IAM gate verifies the token at the GFE,
 *     so by the time the request reaches the app it is already authn'd
 *     as the runtime SA.
 *   - Defense-in-depth: if `CRON_SHARED_SECRET` is bound, additionally
 *     require an `X-Cron-Secret` header match. When unset (dev), the
 *     header check is skipped.
 *
 * Behaviour:
 *   - Selects retreats with `state='scheduled'` AND
 *     `scheduled_start_date <= today (America/New_York)`.
 *     ET (not UTC) so the calendar day matches the schedule's
 *     America/New_York anchor and what clients reason about.
 *   - For each, calls `transitions.markInProgress` which is idempotent.
 *   - Returns a JSON summary `{ checked, transitioned, errors }`.
 *
 * No PHI in response or logs.
 *
 * Audit #33 — cron TZ for non-Eastern clients:
 *   The America/New_York anchor matches every current ITR client (all on
 *   the US East coast, scheduling in their local time). If a future
 *   therapist or location operates in a different timezone, this hard-
 *   coded TZ would flip retreats to in_progress one calendar day late
 *   (or early) for those clients. Fix would be either:
 *     a) per-retreat TZ column, populated from the location, or
 *     b) per-therapist default TZ.
 *   Either path also requires updating the matching Cloud Scheduler job
 *   (scripts/m4-create-scheduler.sh) — keep that in sync if/when changed.
 */

import { Hono } from 'hono';
import { and, eq, lte } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { retreats } from '../../db/schema.js';
import { verifyCronSecret } from '../../lib/cron-auth.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';

export const cronStateTransitionsRoute = new Hono();

cronStateTransitionsRoute.post('/state-transitions', async (c) => {
  if (!verifyCronSecret(c)) {
    log.warn('cron_state_transitions_unauthorized', {});
    return c.json({ error: 'unauthorized' }, 401);
  }

  // YYYY-MM-DD in America/New_York. The schedule fires at 06:05 ET so
  // matching the same TZ avoids a 4–5h same-day-start lag relative to
  // UTC. en-CA gives ISO-style YYYY-MM-DD output.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const { db } = await getDb();

  const due = await db
    .select({ id: retreats.id })
    .from(retreats)
    .where(
      and(
        eq(retreats.state, 'scheduled'),
        lte(retreats.scheduledStartDate, today),
      ),
    );

  let transitioned = 0;
  const errors: { retreatId: string; error: string }[] = [];

  for (const r of due) {
    try {
      await transitions.markInProgress({
        retreatId: r.id,
        actor: { kind: 'system' },
      });
      transitioned += 1;
    } catch (err) {
      const error = (err as Error).message;
      log.error('cron_mark_in_progress_failed', { retreatId: r.id, error });
      errors.push({ retreatId: r.id, error });
    }
  }

  log.info('cron_state_transitions_run', {
    today,
    checked: due.length,
    transitioned,
    errorCount: errors.length,
  });

  return c.json({
    today,
    checked: due.length,
    transitioned,
    errors,
  });
});
