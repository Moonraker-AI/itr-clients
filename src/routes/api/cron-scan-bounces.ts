/**
 * /api/cron/scan-bounces — Cloud Scheduler target (P1 #10, docs/bounce-tracking.md).
 *
 * Pulls Delivery Status Notifications (RFC 3464) from the sending mailbox via
 * Gmail API, parses each, and updates the matching email_log row to
 * status='bounced' with the parsed Diagnostic-Code as bounce_reason.
 *
 * Auth model: same as the other cron routes — OIDC at the GFE plus an optional
 * `X-Cron-Secret` defense-in-depth header.
 *
 * Cadence: 30 min. Bounces typically arrive within minutes of the original
 * send; faster polling buys nothing and increases Gmail API quota burn.
 *
 * No PHI in response. Logs include retreatId + recipient (which is PHI when
 * retreatId is set) so they sit on the same redaction floor as the rest of
 * the email pipeline.
 *
 * Match strategy: DSN `In-Reply-To` (or, fallback, the Message-ID extracted
 * from the embedded `message/rfc822` part) is matched against
 * email_log.message_id. Older rows whose message_id was the Gmail internal id
 * (pre-0007 migration) will not match — that is by design; we cannot retro-
 * actively learn what RFC Message-ID Gmail assigned to those sends.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { emailLog } from '../../db/schema.js';
import { verifyCronSecret } from '../../lib/cron-auth.js';
import { listBounces } from '../../lib/gmail.js';
import { log } from '../../lib/phi-redactor.js';

export const cronScanBouncesRoute = new Hono();

const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h trailing window

cronScanBouncesRoute.post('/scan-bounces', async (c) => {
  if (!verifyCronSecret(c)) {
    log.warn('cron_scan_bounces_unauthorized', {});
    return c.json({ error: 'unauthorized' }, 401);
  }

  const since = new Date(Date.now() - SCAN_WINDOW_MS);
  const bounces = await listBounces({ since });

  const { db } = await getDb();
  let matched = 0;
  let updated = 0;
  const skipped: string[] = [];

  for (const b of bounces) {
    if (!b.inReplyTo) {
      skipped.push('no_in_reply_to');
      continue;
    }

    // Only treat 5.x.x as a hard bounce. 4.x.x is transient — the sending MTA
    // will retry; we don't want to pollute email_log with status='bounced'
    // for a deferral that may still deliver. If statusCode is missing,
    // assume hard (more conservative for ops alerting).
    const isHardBounce = !b.statusCode || b.statusCode.startsWith('5.');
    if (!isHardBounce) {
      skipped.push('transient');
      continue;
    }

    matched += 1;
    const result = await db
      .update(emailLog)
      .set({
        status: 'bounced',
        bouncedAt: b.receivedAt,
        bounceReason: b.failureReason ?? `bounce ${b.statusCode ?? 'unknown'}`,
      })
      .where(
        and(
          eq(emailLog.messageId, b.inReplyTo),
          eq(emailLog.status, 'sent'),
        ),
      );

    const rows = result.rowCount ?? 0;
    updated += rows;
    if (rows === 0) skipped.push('no_email_log_match');
  }

  log.info('cron_scan_bounces_run', {
    since: since.toISOString(),
    found: bounces.length,
    matched,
    updated,
    skippedCounts: tally(skipped),
  });

  return c.json({
    since: since.toISOString(),
    found: bounces.length,
    matched,
    updated,
  });
});

function tally(arr: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of arr) out[s] = (out[s] ?? 0) + 1;
  return out;
}
