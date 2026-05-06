/**
 * Notifications fan-out (DESIGN.md §8).
 *
 *   notify({ event, retreatId, ... }) →
 *     resolve recipients from notification_recipients table →
 *     compose minimal HTML/text body for the event →
 *     send via gmail.ts wrapper →
 *     write a row to email_log per recipient.
 *
 * The body is PHI-free: a one-sentence subject and a link to the
 * authenticated surface (`/c/<token>` or `/admin/clients/<id>`). Real
 * detail lives behind auth in the app.
 */

import { and, eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import {
  emailLog,
  notificationRecipients,
  retreats,
  therapists,
} from '../db/schema.js';
import { sendEmail, type MailAttachment } from './gmail.js';
import { log } from './phi-redactor.js';

/**
 * Action-required events: in addition to the shared inbox seeded in
 * `notification_recipients`, the assigned therapist on the retreat is
 * also notified. Resolved at send time via retreat.therapist_id, so
 * therapists get notified ONLY for their own retreats.
 */
const ACTION_REQUIRED_EVENTS: ReadonlySet<NotifyEvent> = new Set([
  'deposit_paid',
  'final_charge_failed',
  'final_charge_retry_exhausted',
]);

export type NotifyEvent =
  | 'consent_package_sent'
  | 'consents_signed'
  | 'deposit_paid'
  | 'dates_confirmed'
  | 'in_progress'
  | 'completion_submitted'
  | 'final_charged'
  | 'final_charge_failed'
  | 'final_charge_retry_exhausted'
  | 'cancelled';

interface BaseNotifyArgs {
  retreatId: string;
}

interface ConsentPackageSentArgs extends BaseNotifyArgs {
  event: 'consent_package_sent';
  /** PHI: client email is sent the link directly here (separate from team@). */
  clientEmail: string;
  clientFirstName: string;
  clientPortalUrl: string;
}

interface SimpleEventArgs extends BaseNotifyArgs {
  event: Exclude<NotifyEvent, 'consent_package_sent'>;
  adminUrl: string;
  /** Optional MIME attachments. Used by `dates_confirmed` to ship the .ics. */
  attachments?: MailAttachment[];
}

export type NotifyArgs = ConsentPackageSentArgs | SimpleEventArgs;

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

interface Composed {
  subject: string;
  textBody: string;
  htmlBody: string;
  templateName: string;
}

function compose(args: NotifyArgs): Composed {
  const link = args.event === 'consent_package_sent' ? args.clientPortalUrl : args.adminUrl;
  // Append retreat-id tail to internal subjects so an admin scanning their
  // inbox can correlate "this alert is about which retreat?" without
  // opening the body. retreatId is an opaque uuid - NOT PHI - so this
  // doesn't violate the PHI-clean-body principle. Skipped for the
  // client-facing consent_package_sent event so the client doesn't see
  // an internal id appended to their personal email.
  const tag = `[ret #${args.retreatId.slice(0, 8)}]`;
  switch (args.event) {
    case 'consent_package_sent':
      return {
        subject: 'Your Intensive Therapy Retreats consent package',
        textBody:
          `Hi ${args.clientFirstName},\n\n` +
          `Your therapist has prepared your consent package. Please review and sign at the link below - it is unique to you.\n\n` +
          `${link}\n\n` +
          `If you have questions, reply to this email and our team will be in touch.\n`,
        htmlBody:
          `<p>Hi ${esc(args.clientFirstName)},</p>` +
          `<p>Your therapist has prepared your consent package. Please review and sign at the link below - it is unique to you.</p>` +
          `<p><a href="${esc(link)}">${esc(link)}</a></p>` +
          `<p>If you have questions, reply to this email and our team will be in touch.</p>`,
        templateName: 'consent_package_sent',
      };
    case 'consents_signed':
      return {
        subject: `Consents signed ${tag}`,
        textBody: `All required consents have been signed. ${link}\n`,
        htmlBody: `<p>All required consents have been signed.</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
        templateName: 'consents_signed',
      };
    case 'deposit_paid':
      return {
        subject: `Deposit paid - please confirm dates ${tag}`,
        textBody: `Deposit paid. Please confirm dates: ${link}\n`,
        htmlBody: `<p>Deposit paid. Please confirm dates.</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
        templateName: 'deposit_paid',
      };
    case 'dates_confirmed':
      return {
        subject: `Retreat dates confirmed ${tag}`,
        textBody: `Retreat dates have been confirmed. ${link}\n`,
        htmlBody: `<p>Retreat dates have been confirmed.</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
        templateName: 'dates_confirmed',
      };
    case 'in_progress':
      return {
        subject: `Retreat in progress ${tag}`,
        textBody: `Retreat marked in progress. ${link}\n`,
        htmlBody: `<p>Retreat marked in progress.</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
        templateName: 'in_progress',
      };
    case 'completion_submitted':
      return {
        subject: `Retreat completion submitted ${tag}`,
        textBody: `Therapist submitted completion form. ${link}\n`,
        htmlBody: `<p>Therapist submitted completion form.</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
        templateName: 'completion_submitted',
      };
    case 'final_charged':
      return {
        subject: `Final balance charged ${tag}`,
        textBody: `Final balance charged successfully. ${link}\n`,
        htmlBody: `<p>Final balance charged successfully.</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
        templateName: 'final_charged',
      };
    case 'final_charge_failed':
      return {
        subject: `Action needed: final charge failed ${tag}`,
        textBody: `Final charge failed for a retreat. Action needed: ${link}\n`,
        htmlBody: `<p>Final charge failed for a retreat. Action needed.</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
        templateName: 'final_charge_failed',
      };
    case 'final_charge_retry_exhausted':
      return {
        subject: `Action needed: final charge retry attempts exhausted ${tag}`,
        textBody: `All retry attempts for the final charge have failed (3/3). Manual recovery required: ${link}\n`,
        htmlBody: `<p>All retry attempts for the final charge have failed (3/3). Manual recovery required.</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
        templateName: 'final_charge_retry_exhausted',
      };
    case 'cancelled':
      return {
        subject: `Retreat cancelled ${tag}`,
        textBody: `Retreat cancelled. ${link}\n`,
        htmlBody: `<p>Retreat cancelled.</p><p><a href="${esc(link)}">${esc(link)}</a></p>`,
        templateName: 'cancelled',
      };
  }
}

export async function notify(args: NotifyArgs): Promise<void> {
  const composed = compose(args);
  const { db } = await getDb();

  // Resolve internal recipients from the shared notification_recipients
  // table (currently the support@ inbox plus any future shared addresses).
  const internal = await db
    .select({ email: notificationRecipients.email })
    .from(notificationRecipients)
    .where(
      and(
        eq(notificationRecipients.eventType, args.event),
        eq(notificationRecipients.active, true),
      ),
    );

  const recipients = new Set<string>(internal.map((r) => r.email));

  if (ACTION_REQUIRED_EVENTS.has(args.event)) {
    // Loop in only the retreat's assigned therapist - not every active
    // therapist. Resolved per-retreat via retreat.therapist_id.
    const [t] = await db
      .select({ email: therapists.email })
      .from(retreats)
      .innerJoin(therapists, eq(retreats.therapistId, therapists.id))
      .where(eq(retreats.id, args.retreatId));
    if (t?.email) recipients.add(t.email);
  }

  if (args.event === 'consent_package_sent') {
    // Client gets the same email separately; their address is PHI but the
    // body is generic + token-only.
    recipients.add(args.clientEmail);
  }

  const attachments =
    args.event !== 'consent_package_sent' ? args.attachments : undefined;

  for (const to of recipients) {
    try {
      const res = await sendEmail({
        to,
        subject: composed.subject,
        textBody: composed.textBody,
        htmlBody: composed.htmlBody,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
      await db.insert(emailLog).values({
        retreatId: args.retreatId,
        recipient: to,
        templateName: composed.templateName,
        gmailMessageId: res.messageId,
        status: 'sent',
      });
    } catch (err) {
      log.error('notify_send_failed', {
        event: args.event,
        retreatId: args.retreatId,
        error: (err as Error).message,
      });
      // Audit #28: durable per-recipient failure record. The state-machine
      // commit is NOT gated on email delivery (one bad recipient must not
      // abort the fan-out), but we still need a row in email_log so an
      // operator can later answer "did this recipient ever receive X?"
      // Best-effort: if even this insert fails (DB outage), the ERROR log
      // above is the last line of defense.
      try {
        await db.insert(emailLog).values({
          retreatId: args.retreatId,
          recipient: to,
          templateName: composed.templateName,
          gmailMessageId: null,
          status: 'failed',
        });
      } catch (logErr) {
        log.error('notify_email_log_insert_failed', {
          event: args.event,
          retreatId: args.retreatId,
          error: (logErr as Error).message,
        });
      }
    }
  }
}
