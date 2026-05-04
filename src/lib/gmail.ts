/**
 * Gmail send wrapper (DESIGN.md §8 — `gmail.ts`).
 *
 * Uses Workspace domain-wide delegation: a Workspace SA (whose JSON key
 * is in Secret Manager as `gmail-service-account`) impersonates the
 * `clients@intensivetherapyretreat.com` mailbox to send email. The
 * Workspace BAA covers Gmail-as-sending-infra (GCP_BOOTSTRAP §2).
 *
 * Body content is intentionally PHI-free per DESIGN.md §8 — only the
 * client_token-bearing link goes out; everything else stays in the
 * authenticated app.
 *
 * Dev mode: set `GMAIL_DRY_RUN=1` and the wrapper logs the message
 * instead of sending. Used by smoke tests + local dev where the secret
 * may not be present.
 */

import { google } from 'googleapis';

import { log } from './phi-redactor.js';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SUBJECT_USER = 'clients@intensivetherapyretreat.com';

export interface MailAttachment {
  /** Final filename. PHI-free per DESIGN §8 (e.g. "retreat.ics"). */
  filename: string;
  /** e.g. "text/calendar; method=PUBLISH; charset=UTF-8". */
  mimeType: string;
  /** Raw content. Strings are encoded UTF-8 before base64. */
  content: Buffer | string;
}

export interface SendArgs {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  /** From header. Defaults to the impersonated subject user. */
  fromName?: string;
  /** Optional MIME attachments. Each is base64-encoded into a multipart/mixed
   *  envelope wrapping the text/html alternative. */
  attachments?: MailAttachment[];
}

export interface SendResult {
  /** Gmail message id, or `dry_run:<rand>` when DRY_RUN was set. */
  messageId: string;
  dryRun: boolean;
}

let cachedKey: { client_email: string; private_key: string } | null = null;

async function loadServiceAccountKey(): Promise<{
  client_email: string;
  private_key: string;
}> {
  if (cachedKey) return cachedKey;
  const raw = process.env.GMAIL_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error('GMAIL_SERVICE_ACCOUNT_KEY env var missing');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GMAIL_SERVICE_ACCOUNT_KEY is not valid JSON');
  }
  const obj = parsed as Record<string, unknown>;
  const clientEmail = typeof obj['client_email'] === 'string' ? obj['client_email'] : '';
  const privateKey = typeof obj['private_key'] === 'string' ? obj['private_key'] : '';
  if (!clientEmail || !privateKey) {
    throw new Error('GMAIL_SERVICE_ACCOUNT_KEY missing client_email or private_key');
  }
  cachedKey = { client_email: clientEmail, private_key: privateKey };
  return cachedKey;
}

function rand(): string {
  return `${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function rfc2822(args: SendArgs): string {
  const from = args.fromName
    ? `${args.fromName} <${SUBJECT_USER}>`
    : SUBJECT_USER;
  const altBoundary = `alt_${rand()}`;

  const altPart = buildAlternative(args, altBoundary);

  const hasAttachments = (args.attachments?.length ?? 0) > 0;
  if (!hasAttachments) {
    const headers = [
      `From: ${from}`,
      `To: ${args.to}`,
      `Subject: ${encodeHeader(args.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
    ].join('\r\n');
    return `${headers}\r\n${altPart}`;
  }

  const mixedBoundary = `mixed_${rand()}`;
  const headers = [
    `From: ${from}`,
    `To: ${args.to}`,
    `Subject: ${encodeHeader(args.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
  ].join('\r\n');

  const altWrapped = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    altPart.replace(/\r\n$/, ''),
    '',
  ].join('\r\n');

  const attachmentParts = (args.attachments ?? [])
    .map((a) => buildAttachmentPart(a, mixedBoundary))
    .join('');

  const closing = `--${mixedBoundary}--\r\n`;

  return `${headers}\r\n${altWrapped}\r\n${attachmentParts}${closing}`;
}

function buildAlternative(args: SendArgs, boundary: string): string {
  const text = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    args.textBody,
    '',
  ].join('\r\n');

  const html = [
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    args.htmlBody,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return `${text}${html}`;
}

function buildAttachmentPart(att: MailAttachment, boundary: string): string {
  const buf = typeof att.content === 'string' ? Buffer.from(att.content, 'utf8') : att.content;
  const b64 = buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
  const trailing = b64.endsWith('\r\n') ? '' : '\r\n';
  return [
    `--${boundary}`,
    `Content-Type: ${att.mimeType}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${att.filename.replaceAll('"', '')}"`,
    '',
    `${b64}${trailing}`,
  ].join('\r\n');
}

function encodeHeader(s: string): string {
  // Use RFC 2047 encoded-word form for any non-ASCII or special char.
  // Keep it simple: ascii-only subjects pass through; otherwise encode.
  if (/^[\x20-\x7e]+$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function assertNoHeaderInjection(field: string, value: string): void {
  if (typeof value !== 'string') {
    throw new Error(`gmail: ${field} must be a string`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`gmail: ${field} contains CR/LF — refused (header injection)`);
  }
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  // Header-injection guard (M9 fix #9). Any CR/LF in `to`, `subject`, or
  // attachment `filename` lets a poisoned input append arbitrary RFC 2822
  // headers (Bcc:, From:) and turn the message into a smuggling vector.
  // We refuse the send rather than try to sanitize.
  assertNoHeaderInjection('to', args.to);
  assertNoHeaderInjection('subject', args.subject);
  if (args.fromName) assertNoHeaderInjection('fromName', args.fromName);
  for (const a of args.attachments ?? []) {
    assertNoHeaderInjection(`attachment.filename`, a.filename);
    assertNoHeaderInjection(`attachment.mimeType`, a.mimeType);
  }

  // Dry-run if explicitly requested OR if the service-account key is not
  // bound. Lets dev environments run end-to-end without a Workspace SA
  // secret; prod must bind GMAIL_SERVICE_ACCOUNT_KEY to send for real.
  if (
    process.env.GMAIL_DRY_RUN === '1' ||
    !process.env.GMAIL_SERVICE_ACCOUNT_KEY
  ) {
    const messageId = `dry_run:${Math.random().toString(36).slice(2, 10)}`;
    log.info('gmail_dry_run', {
      to: args.to,
      subject: args.subject,
      messageId,
      reason:
        process.env.GMAIL_DRY_RUN === '1'
          ? 'GMAIL_DRY_RUN=1'
          : 'GMAIL_SERVICE_ACCOUNT_KEY unset',
    });
    return { messageId, dryRun: true };
  }

  const key = await loadServiceAccountKey();
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [GMAIL_SCOPE],
    subject: SUBJECT_USER,
  });

  const gmail = google.gmail({ version: 'v1', auth });
  const raw = base64Url(Buffer.from(rfc2822(args), 'utf8'));

  // 10s timeout (M9 fix #20). googleapis/gaxios supports a per-request
  // timeout that aborts the underlying HTTP socket; without it a network
  // hang stalls the request path for the gaxios default (~30s) and pins
  // Cloud Run instance slots inside state-machine transitions.
  const res = await gmail.users.messages.send(
    {
      userId: 'me',
      requestBody: { raw },
    },
    { timeout: 10_000 },
  );

  const messageId = res.data.id ?? '';
  if (!messageId) throw new Error('gmail send returned no message id');
  log.info('gmail_sent', { to: args.to, subject: args.subject, messageId });
  return { messageId, dryRun: false };
}
