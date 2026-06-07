import { getDb } from '../db/client.js';
import { emailLog } from '../db/schema.js';
import { sendEmail } from './gmail.js';
import { emailButton, wrapEmailHtml } from './notifications.js';
import { log } from './phi-redactor.js';

const DEFAULT_ADMIN_EMAILS = [
  'chris@intensivetherapyretreat.com',
  'bambi@intensivetherapyretreat.com',
];

function baseUrl(): string {
  return process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ??
    'https://clients.intensivetherapyretreat.com';
}

function configuredAdminEmails(): string[] {
  const raw = process.env.CONTACT_INQUIRY_ADMIN_EMAILS;
  if (!raw) return DEFAULT_ADMIN_EMAILS;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function uniqEmails(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

export function inquiryRecipients(therapistEmail: string | null | undefined): string[] {
  return uniqEmails([...(therapistEmail ? [therapistEmail] : []), ...configuredAdminEmails()]);
}

export async function sendInquiryReceivedEmail(args: {
  inquiryId: string;
  therapistEmail: string;
  therapistName: string;
}): Promise<void> {
  const firstName = args.therapistName.split(' ')[0] ?? args.therapistName;
  await sendInternalInquiryEmail({
    inquiryId: args.inquiryId,
    recipients: inquiryRecipients(args.therapistEmail),
    subject: `New Inquiry for ${args.therapistName}`,
    templateName: 'contact_inquiry_received',
    textIntro: `${firstName}, you have a new inquiry. Sign in to read it securely.`,
    htmlIntro: `${firstName}, you have a new inquiry. Tap the button below to sign in and read it securely.`,
  });
}

export async function sendInquiryReassignedEmail(args: {
  inquiryId: string;
  therapistEmail: string;
}): Promise<void> {
  await sendInternalInquiryEmail({
    inquiryId: args.inquiryId,
    recipients: inquiryRecipients(args.therapistEmail),
    subject: 'ITR inquiry reassigned',
    templateName: 'contact_inquiry_reassigned',
    textIntro: 'An inquiry was reassigned. Sign in to review it securely.',
    htmlIntro: 'An inquiry was reassigned. Sign in to review it securely.',
  });
}

async function sendInternalInquiryEmail(args: {
  inquiryId: string;
  recipients: string[];
  subject: string;
  templateName: string;
  textIntro: string;
  htmlIntro: string;
}): Promise<void> {
  const url = `${baseUrl()}/admin/inquiries/${args.inquiryId}`;
  const htmlBody = wrapEmailHtml(
    `<p style="margin:0 0 14px 0;">${args.htmlIntro}</p>` +
      emailButton(url, 'View Message'),
    { preheader: args.subject },
  );
  const textBody = `${args.textIntro}\n\nView message: ${url}\n`;
  const { db } = await getDb();

  for (const to of args.recipients) {
    try {
      const result = await sendEmail({
        to,
        subject: args.subject,
        fromName: 'ITR Website',
        textBody,
        htmlBody,
      });
      await db.insert(emailLog).values({
        retreatId: null,
        recipient: to,
        templateName: args.templateName,
        messageId: result.messageId,
        status: 'sent',
      });
    } catch (err) {
      log.error('inquiry_internal_email_failed', {
        inquiryId: args.inquiryId,
        templateName: args.templateName,
        recipient: to,
        error: (err as Error).message,
      });
      try {
        await db.insert(emailLog).values({
          retreatId: null,
          recipient: to,
          templateName: args.templateName,
          messageId: null,
          status: 'failed',
        });
      } catch (logErr) {
        log.error('inquiry_email_log_insert_failed', {
          inquiryId: args.inquiryId,
          error: (logErr as Error).message,
        });
      }
    }
  }
}

export async function sendInquiryConfirmationEmail(args: {
  to: string;
  firstName: string;
}): Promise<void> {
  const htmlBody = wrapEmailHtml(
    `<p style="margin:0 0 14px 0;">Hi ${escapeHtml(args.firstName)},</p>` +
      `<p style="margin:0 0 14px 0;">We received your inquiry. A therapist will review it and follow up using the contact preferences you provided.</p>` +
      `<p style="margin:0;">If this is an emergency, call 911 or call or text 988.</p>`,
    { preheader: 'We received your Intensive Therapy Retreats inquiry.' },
  );
  const textBody =
    `Hi ${args.firstName},\n\n` +
    `We received your inquiry. A therapist will review it and follow up using the contact preferences you provided.\n\n` +
    `If this is an emergency, call 911 or call or text 988.\n`;
  const { db } = await getDb();

  try {
    const result = await sendEmail({
      to: args.to,
      subject: 'We received your Intensive Therapy Retreats inquiry',
      textBody,
      htmlBody,
    });
    await db.insert(emailLog).values({
      retreatId: null,
      recipient: args.to,
      templateName: 'contact_inquiry_confirmation',
      messageId: result.messageId,
      status: 'sent',
    });
  } catch (err) {
    log.error('inquiry_confirmation_email_failed', {
      error: (err as Error).message,
    });
    try {
      await db.insert(emailLog).values({
        retreatId: null,
        recipient: args.to,
        templateName: 'contact_inquiry_confirmation',
        messageId: null,
        status: 'failed',
      });
    } catch (logErr) {
      log.error('inquiry_confirmation_email_log_insert_failed', {
        error: (logErr as Error).message,
      });
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
