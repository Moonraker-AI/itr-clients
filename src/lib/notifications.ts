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

export interface Composed {
  subject: string;
  textBody: string;
  htmlBody: string;
  templateName: string;
}

/**
 * Brand palette for email-safe HTML (hex equivalents of the OKLCH design
 * tokens in src/styles/app.css). Gmail / Outlook / Apple Mail don't
 * reliably support oklch(), so the email template is committed to a
 * frozen hex snapshot and updated alongside theme bumps.
 */
const EMAIL_BRAND = {
  frame: '#3a5e60',          // dark teal — top + bottom bars
  frameText: '#f0ede2',      // cream-on-teal text in bars
  contentBg: '#faf9f4',      // cream content area
  contentText: '#2c3a3c',    // dark slate body text
  muted: '#6b7c7e',
  link: '#3a5e60',
  rule: '#d6d2c3',
  pageBg: '#e8e3d4',         // outer page bg
};

/**
 * Resolve the absolute base URL used for the logo + footer link in email
 * HTML. Real sends supply the env; the /admin/email-preview route uses a
 * computed-from-request fallback so previews work out-of-the-box even
 * when PUBLIC_BASE_URL is unset locally.
 */
function emailBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ??
    'https://clients.intensivetherapyretreat.com';
}

/**
 * Wrap a body fragment (typically `<p>` tags) in the framed ITR email
 * shell: dark top bar with logo, cream content card, dark bottom bar
 * with footer. Uses table-based layout so it renders consistently in
 * Outlook / Gmail / Apple Mail / mobile webviews.
 */
export function wrapEmailHtml(
  inner: string,
  opts?: { preheader?: string | undefined; baseUrl?: string | undefined },
): string {
  const base = (opts?.baseUrl ?? emailBaseUrl()).replace(/\/$/, '');
  const logoUrl = `${base}/static/brand/logo.png`;
  const preheader = opts?.preheader ?? '';
  const year = new Date().getUTCFullYear();
  const td = (style: string, content: string): string =>
    `<td style="${style}">${content}</td>`;

  // Preheader text: invisible inbox-preview line. Hidden via the canonical
  // mso-hide + display:none trick so it shows in the inbox preview pane
  // but doesn't render inside the open message.
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${EMAIL_BRAND.contentBg};">${esc(
        preheader,
      )}</div>`
    : '';

  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Intensive Therapy Retreats</title></head>`,
    `<body style="margin:0;padding:0;background:${EMAIL_BRAND.pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${EMAIL_BRAND.contentText};">`,
    preheaderHtml,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_BRAND.pageBg};padding:24px 12px;">`,
    `<tr>`,
    td(
      'text-align:center;',
      [
        `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${EMAIL_BRAND.contentBg};border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.04);">`,
        `<tr>`,
        td(
          `background:${EMAIL_BRAND.frame};padding:20px 28px;text-align:left;`,
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
            td(
              'vertical-align:middle;',
              `<img src="${esc(logoUrl)}" alt="Intensive Therapy Retreats" width="40" height="40" style="display:inline-block;vertical-align:middle;border:0;outline:none;text-decoration:none;height:40px;width:40px;" />`,
            ) +
            td(
              `padding-left:12px;vertical-align:middle;font-size:16px;font-weight:600;letter-spacing:0.02em;color:${EMAIL_BRAND.frameText};`,
              'Intensive Therapy Retreats',
            ) +
            `</tr></table>`,
        ),
        `</tr>`,
        `<tr>`,
        td(
          `padding:32px 32px 24px 32px;text-align:left;color:${EMAIL_BRAND.contentText};font-size:15px;line-height:1.55;`,
          inner,
        ),
        `</tr>`,
        `<tr>`,
        td(
          `background:${EMAIL_BRAND.frame};padding:16px 28px;text-align:left;color:${EMAIL_BRAND.frameText};font-size:12px;line-height:1.5;`,
          `<div>Intensive Therapy Retreats &middot; Northampton, MA</div>` +
            `<div style="margin-top:4px;opacity:0.85;">This is an automated message from the ITR Clients system. &copy; ${year}</div>`,
        ),
        `</tr>`,
        `</table>`,
      ].join(''),
    ),
    `</tr>`,
    `</table>`,
    `</body></html>`,
  ].join('');
}

/**
 * Style a body link consistently with the brand palette. Used in the
 * per-event htmlBody fragments so plain-text-style anchors don't appear
 * blue-on-cream in Gmail.
 */
function emailLink(href: string): string {
  return `<a href="${esc(href)}" style="color:${EMAIL_BRAND.link};text-decoration:underline;">${esc(href)}</a>`;
}

/**
 * Build the subject + text + html body for a notify event WITHOUT sending.
 * Exposed so the admin /admin/email-preview route can render the same
 * output a real send would, using fake-but-shaped sample inputs.
 */
export function composeNotification(args: NotifyArgs): Composed {
  return compose(args);
}

function compose(args: NotifyArgs): Composed {
  const link = args.event === 'consent_package_sent' ? args.clientPortalUrl : args.adminUrl;
  const linkHtml = emailLink(link);
  // Append retreat-id tail to internal subjects so an admin scanning their
  // inbox can correlate "this alert is about which retreat?" without
  // opening the body. retreatId is an opaque uuid - NOT PHI - so this
  // doesn't violate the PHI-clean-body principle. Skipped for the
  // client-facing consent_package_sent event so the client doesn't see
  // an internal id appended to their personal email.
  const tag = `[ret #${args.retreatId.slice(0, 8)}]`;
  let raw: { subject: string; textBody: string; htmlInner: string; templateName: string; preheader?: string };
  switch (args.event) {
    case 'consent_package_sent':
      raw = {
        subject: 'Your Intensive Therapy Retreats consent package',
        preheader: 'Your therapist has prepared your consent package. Sign at the link inside.',
        textBody:
          `Hi ${args.clientFirstName},\n\n` +
          `Your therapist has prepared your consent package. Please review and sign at the link below - it is unique to you.\n\n` +
          `${link}\n\n` +
          `If you have questions, reply to this email and our team will be in touch.\n`,
        htmlInner:
          `<p style="margin:0 0 14px 0;">Hi ${esc(args.clientFirstName)},</p>` +
          `<p style="margin:0 0 14px 0;">Your therapist has prepared your consent package. Please review and sign at the link below — it is unique to you.</p>` +
          `<p style="margin:0 0 14px 0;">${linkHtml}</p>` +
          `<p style="margin:0;">If you have questions, reply to this email and our team will be in touch.</p>`,
        templateName: 'consent_package_sent',
      };
      break;
    case 'consents_signed':
      raw = {
        subject: `Consents signed ${tag}`,
        textBody: `All required consents have been signed. ${link}\n`,
        htmlInner: `<p style="margin:0 0 14px 0;">All required consents have been signed.</p><p style="margin:0;">${linkHtml}</p>`,
        templateName: 'consents_signed',
      };
      break;
    case 'deposit_paid':
      raw = {
        subject: `Deposit paid - please confirm dates ${tag}`,
        textBody: `Deposit paid. Please confirm dates: ${link}\n`,
        htmlInner: `<p style="margin:0 0 14px 0;">Deposit paid. Please confirm dates.</p><p style="margin:0;">${linkHtml}</p>`,
        templateName: 'deposit_paid',
      };
      break;
    case 'dates_confirmed':
      raw = {
        subject: `Retreat dates confirmed ${tag}`,
        textBody: `Retreat dates have been confirmed. ${link}\n`,
        htmlInner: `<p style="margin:0 0 14px 0;">Retreat dates have been confirmed.</p><p style="margin:0;">${linkHtml}</p>`,
        templateName: 'dates_confirmed',
      };
      break;
    case 'in_progress':
      raw = {
        subject: `Retreat in progress ${tag}`,
        textBody: `Retreat marked in progress. ${link}\n`,
        htmlInner: `<p style="margin:0 0 14px 0;">Retreat marked in progress.</p><p style="margin:0;">${linkHtml}</p>`,
        templateName: 'in_progress',
      };
      break;
    case 'completion_submitted':
      raw = {
        subject: `Retreat completion submitted ${tag}`,
        textBody: `Therapist submitted completion form. ${link}\n`,
        htmlInner: `<p style="margin:0 0 14px 0;">Therapist submitted completion form.</p><p style="margin:0;">${linkHtml}</p>`,
        templateName: 'completion_submitted',
      };
      break;
    case 'final_charged':
      raw = {
        subject: `Final balance charged ${tag}`,
        textBody: `Final balance charged successfully. ${link}\n`,
        htmlInner: `<p style="margin:0 0 14px 0;">Final balance charged successfully.</p><p style="margin:0;">${linkHtml}</p>`,
        templateName: 'final_charged',
      };
      break;
    case 'final_charge_failed':
      raw = {
        subject: `Action needed: final charge failed ${tag}`,
        textBody: `Final charge failed for a retreat. Action needed: ${link}\n`,
        htmlInner: `<p style="margin:0 0 14px 0;">Final charge failed for a retreat. Action needed.</p><p style="margin:0;">${linkHtml}</p>`,
        templateName: 'final_charge_failed',
      };
      break;
    case 'final_charge_retry_exhausted':
      raw = {
        subject: `Action needed: final charge retry attempts exhausted ${tag}`,
        textBody: `All retry attempts for the final charge have failed (3/3). Manual recovery required: ${link}\n`,
        htmlInner: `<p style="margin:0 0 14px 0;">All retry attempts for the final charge have failed (3/3). Manual recovery required.</p><p style="margin:0;">${linkHtml}</p>`,
        templateName: 'final_charge_retry_exhausted',
      };
      break;
    case 'cancelled':
      raw = {
        subject: `Retreat cancelled ${tag}`,
        textBody: `Retreat cancelled. ${link}\n`,
        htmlInner: `<p style="margin:0 0 14px 0;">Retreat cancelled.</p><p style="margin:0;">${linkHtml}</p>`,
        templateName: 'cancelled',
      };
      break;
  }
  return {
    subject: raw.subject,
    textBody: raw.textBody,
    htmlBody: wrapEmailHtml(raw.htmlInner, { preheader: raw.preheader }),
    templateName: raw.templateName,
  };
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
        messageId: res.messageId,
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
          messageId: null,
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
