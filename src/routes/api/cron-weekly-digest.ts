/**
 * /api/cron/weekly-digest - weekly per-client nudges + admin rollup
 * (P3, v0.22.0). Fired by Cloud Scheduler on a weekly cadence (Sunday
 * 7am ET - see scripts/m22-create-weekly-digest-scheduler.sh).
 *
 * Two phases:
 *   1. **Per-client reminders.** For every retreat in `awaiting_consents`
 *      or `awaiting_deposit`, send a personalized PHI-safe nudge to the
 *      client's email with a token-only link to the portal. State-machine
 *      transitions already handle the major lifecycle moments
 *      (consent_package_sent, deposit_paid, etc); this digest covers
 *      the *quiet* middle where the client has stalled and just needs
 *      a friendly reminder.
 *   2. **Admin rollup.** Send one aggregate email to a hardcoded set
 *      of internal recipients (bambi@itr + chris@itr + support@moonraker)
 *      summarizing state counts, retreats stuck >7 days, and payment
 *      failures + bounces in the last 7 days.
 *
 * Auth: same OIDC + X-Cron-Secret pattern as the other crons.
 *
 * Idempotency: each phase emits an audit_event after each sent email
 * (`weekly_client_digest_sent` + `weekly_admin_rollup_sent`). Re-running
 * the cron the same day will resend everything. The Scheduler job is
 * weekly so this isn't a concern in normal ops; manual re-fires should
 * be deliberate.
 */

import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  auditEvents,
  clients,
  emailLog,
  payments,
  retreats,
  therapists,
} from '../../db/schema.js';
import { verifyCronSecret } from '../../lib/cron-auth.js';
import { sendEmail } from '../../lib/gmail.js';
import { log } from '../../lib/phi-redactor.js';

export const cronWeeklyDigestRoute = new Hono();

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function esc(s: string): string {
  return s.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c] ?? c);
}

const ADMIN_ROLLUP_RECIPIENTS_DEFAULT = [
  'bambi@intensivetherapyretreat.com',
  'chris@intensivetherapyretreat.com',
  'support@moonraker.ai',
];

const STALE_THRESHOLD_DAYS = 7;
const ROLLUP_WINDOW_DAYS = 7;

function publicBaseUrl(): string {
  const url = process.env.PUBLIC_BASE_URL;
  if (url) return url;
  if (process.env.AUTH_ENABLED === '1') {
    throw new Error('PUBLIC_BASE_URL is required when AUTH_ENABLED=1');
  }
  return 'https://itr-client-hq-buejbopu5q-uc.a.run.app';
}

function adminRollupRecipients(): string[] {
  const override = process.env.WEEKLY_ROLLUP_RECIPIENTS;
  if (!override) return ADMIN_ROLLUP_RECIPIENTS_DEFAULT;
  return override
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

cronWeeklyDigestRoute.post('/weekly-digest', async (c) => {
  if (!verifyCronSecret(c)) {
    log.warn('cron_weekly_digest_unauthorized', {});
    return c.json({ error: 'unauthorized' }, 401);
  }

  const { db } = await getDb();
  const baseUrl = publicBaseUrl();

  // ---------------------------------------------------------------
  // Phase 1: per-client reminders.
  // ---------------------------------------------------------------
  const stalledStates: ('awaiting_consents' | 'awaiting_deposit')[] = [
    'awaiting_consents',
    'awaiting_deposit',
  ];
  const stalled = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      clientToken: retreats.clientToken,
      clientEmail: clients.email,
      clientFirstName: clients.firstName,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .where(inArray(retreats.state, stalledStates));

  let clientSent = 0;
  let clientFailed = 0;
  for (const r of stalled) {
    const portalUrl = `${baseUrl}/c/${r.clientToken}`;
    const nextLabel =
      r.state === 'awaiting_consents'
        ? 'review and sign your consent forms'
        : 'complete your deposit to confirm your retreat';
    const subject = 'A reminder from Intensive Therapy Retreats';
    const text =
      `Hi ${r.clientFirstName},\n\n` +
      `This is a friendly reminder that you still need to ${nextLabel}.\n\n` +
      `Pick up where you left off:\n${portalUrl}\n\n` +
      `If you have questions, reply to this email and our team will be in touch.\n`;
    const html =
      `<p>Hi ${esc(r.clientFirstName)},</p>` +
      `<p>This is a friendly reminder that you still need to ${esc(nextLabel)}.</p>` +
      `<p>Pick up where you left off: <a href="${esc(portalUrl)}">${esc(portalUrl)}</a></p>` +
      `<p>If you have questions, reply to this email and our team will be in touch.</p>`;

    try {
      const res = await sendEmail({
        to: r.clientEmail,
        subject,
        textBody: text,
        htmlBody: html,
      });
      await db.insert(emailLog).values({
        retreatId: r.retreatId,
        recipient: r.clientEmail,
        templateName: 'weekly_client_digest',
        messageId: res.messageId,
        status: 'sent',
      });
      await db.insert(auditEvents).values({
        retreatId: r.retreatId,
        actorType: 'system',
        actorId: null,
        eventType: 'weekly_client_digest_sent',
        payload: { state: r.state },
      });
      clientSent += 1;
    } catch (err) {
      const error = (err as Error).message;
      log.warn('weekly_digest_client_failed', { retreatId: r.retreatId, error });
      try {
        await db.insert(emailLog).values({
          retreatId: r.retreatId,
          recipient: r.clientEmail,
          templateName: 'weekly_client_digest',
          messageId: null,
          status: 'failed',
        });
      } catch {
        // best-effort
      }
      clientFailed += 1;
    }
  }

  // ---------------------------------------------------------------
  // Phase 2: admin rollup.
  // ---------------------------------------------------------------
  const stateCountRows = await db
    .select({
      state: retreats.state,
      count: sql<number>`count(*)::int`,
    })
    .from(retreats)
    .groupBy(retreats.state);
  const stateCounts: Record<string, number> = {};
  for (const r of stateCountRows) stateCounts[r.state] = Number(r.count);

  const staleSince = new Date(Date.now() - STALE_THRESHOLD_DAYS * 86_400_000);
  const stuck = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      updatedAt: retreats.updatedAt,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      therapistFullName: therapists.fullName,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .innerJoin(therapists, eq(retreats.therapistId, therapists.id))
    .where(
      and(
        inArray(retreats.state, stalledStates),
        sql`${retreats.updatedAt} < ${staleSince.toISOString()}`,
      ),
    )
    .orderBy(desc(retreats.updatedAt))
    .limit(50);

  const windowSince = new Date(Date.now() - ROLLUP_WINDOW_DAYS * 86_400_000);
  const failedPayments = await db
    .select({
      retreatId: payments.retreatId,
      kind: payments.kind,
      failureCode: payments.failureCode,
      failureMessage: payments.failureMessage,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(eq(payments.status, 'failed'), gte(payments.createdAt, windowSince)))
    .orderBy(desc(payments.createdAt))
    .limit(25);

  const recentBounces = await db
    .select({
      retreatId: emailLog.retreatId,
      recipient: emailLog.recipient,
      templateName: emailLog.templateName,
      bouncedAt: emailLog.bouncedAt,
      bounceReason: emailLog.bounceReason,
    })
    .from(emailLog)
    .where(and(eq(emailLog.status, 'bounced'), gte(emailLog.sentAt, windowSince)))
    .orderBy(desc(emailLog.sentAt))
    .limit(25);

  const adminUrlForRetreat = (retreatId: string): string =>
    `${baseUrl}/admin/clients/${retreatId}`;

  const stateCountList = Object.entries(stateCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, n]) => `  - ${s}: ${n}`)
    .join('\n');
  const stuckList = stuck.length === 0
    ? '  (none)'
    : stuck
        .map(
          (s) =>
            `  - ${s.state}: ${s.clientFirstName} ${s.clientLastName} (therapist ${s.therapistFullName}) - last touch ${s.updatedAt.toISOString().slice(0, 10)} → ${adminUrlForRetreat(s.retreatId)}`,
        )
        .join('\n');
  const failuresList = failedPayments.length === 0
    ? '  (none)'
    : failedPayments
        .map(
          (p) =>
            `  - ${p.kind} ${p.failureCode ?? '?'}${p.failureMessage ? `: ${p.failureMessage}` : ''} → ${adminUrlForRetreat(p.retreatId ?? '')}`,
        )
        .join('\n');
  const bouncesList = recentBounces.length === 0
    ? '  (none)'
    : recentBounces
        .map(
          (b) =>
            `  - ${b.templateName} → ${b.recipient} bounced (${b.bounceReason ?? 'unknown'}) on ${b.bouncedAt?.toISOString().slice(0, 10) ?? '?'} → ${b.retreatId ? adminUrlForRetreat(b.retreatId) : '(no retreat link)'}`,
        )
        .join('\n');

  const rollupText =
    `ITR Clients weekly rollup (${new Date().toISOString().slice(0, 10)})\n\n` +
    `State counts (all time):\n${stateCountList}\n\n` +
    `Stuck >7d in awaiting_consents / awaiting_deposit (top 50):\n${stuckList}\n\n` +
    `Payment failures (last 7d, top 25):\n${failuresList}\n\n` +
    `Email bounces (last 7d, top 25):\n${bouncesList}\n\n` +
    `Per-client reminders sent this run: ${clientSent} ok, ${clientFailed} failed.\n`;

  const rollupHtml =
    `<h2>ITR Clients weekly rollup (${esc(new Date().toISOString().slice(0, 10))})</h2>` +
    `<h3>State counts (all time)</h3><pre style="font-family:monospace">${esc(stateCountList)}</pre>` +
    `<h3>Stuck >7d in awaiting_consents / awaiting_deposit (top 50)</h3><pre style="font-family:monospace">${esc(stuckList)}</pre>` +
    `<h3>Payment failures (last 7d, top 25)</h3><pre style="font-family:monospace">${esc(failuresList)}</pre>` +
    `<h3>Email bounces (last 7d, top 25)</h3><pre style="font-family:monospace">${esc(bouncesList)}</pre>` +
    `<p><em>Per-client reminders sent this run: ${clientSent} ok, ${clientFailed} failed.</em></p>`;

  const recipients = adminRollupRecipients();
  let adminSent = 0;
  let adminFailed = 0;
  for (const to of recipients) {
    try {
      const res = await sendEmail({
        to,
        subject: `Weekly rollup ${new Date().toISOString().slice(0, 10)}`,
        textBody: rollupText,
        htmlBody: rollupHtml,
      });
      await db.insert(emailLog).values({
        retreatId: null,
        recipient: to,
        templateName: 'weekly_admin_rollup',
        messageId: res.messageId,
        status: 'sent',
      });
      adminSent += 1;
    } catch (err) {
      const error = (err as Error).message;
      log.warn('weekly_digest_admin_failed', { to, error });
      try {
        await db.insert(emailLog).values({
          retreatId: null,
          recipient: to,
          templateName: 'weekly_admin_rollup',
          messageId: null,
          status: 'failed',
        });
      } catch {
        // best-effort
      }
      adminFailed += 1;
    }
  }
  await db.insert(auditEvents).values({
    retreatId: null,
    actorType: 'system',
    actorId: null,
    eventType: 'weekly_admin_rollup_sent',
    payload: {
      recipients: recipients.length,
      adminSent,
      adminFailed,
      stuckCount: stuck.length,
      paymentFailureCount: failedPayments.length,
      bounceCount: recentBounces.length,
    },
  });

  log.info('cron_weekly_digest_run', {
    clientSent,
    clientFailed,
    adminSent,
    adminFailed,
    stuck: stuck.length,
    paymentFailures: failedPayments.length,
    bounces: recentBounces.length,
  });

  return c.json({
    clientSent,
    clientFailed,
    adminSent,
    adminFailed,
    stuck: stuck.length,
    paymentFailures: failedPayments.length,
    bounces: recentBounces.length,
  });
});
