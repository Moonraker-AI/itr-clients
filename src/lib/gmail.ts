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

import { randomUUID } from 'node:crypto';

import { google } from 'googleapis';

import { log } from './phi-redactor.js';

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SUBJECT_USER = 'clients@intensivetherapyretreat.com';

/**
 * Domain we use as the right-hand side of generated Message-ID headers.
 * Has to be a domain we own or are responsible for per RFC 5322 §3.6.4.
 */
const MESSAGE_ID_DOMAIN = 'clients.intensivetherapyretreat.com';

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
  /**
   * RFC 5322 Message-ID we set on the outbound email (without angle brackets).
   * The bounce-scan cron matches inbound DSN `In-Reply-To` headers against
   * this value to mark email_log rows as bounced. Format: `<uuid@domain>`
   * stripped of brackets when stored.
   * In dry-run, this is `dry_run:<rand>` instead.
   */
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

function rfc2822(args: SendArgs, messageId: string): string {
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
      `Message-ID: <${messageId}>`,
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
    `Message-ID: <${messageId}>`,
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
  // Generate the RFC 5322 Message-ID up front so it goes into both the
  // outbound headers and the SendResult that the caller persists. Storing
  // this exact id (without brackets) is what lets cron-scan-bounces match
  // an inbound DSN's `In-Reply-To` back to the original email_log row.
  const rfcMessageId = `${randomUUID()}@${MESSAGE_ID_DOMAIN}`;

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
    scopes: [GMAIL_SEND_SCOPE],
    subject: SUBJECT_USER,
  });

  const gmail = google.gmail({ version: 'v1', auth });
  const raw = base64Url(Buffer.from(rfc2822(args, rfcMessageId), 'utf8'));

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

  if (!res.data.id) throw new Error('gmail send returned no message id');
  log.info('gmail_sent', {
    to: args.to,
    subject: args.subject,
    messageId: rfcMessageId,
    gmailInternalId: res.data.id,
  });
  return { messageId: rfcMessageId, dryRun: false };
}

// ---------------------------------------------------------------------------
// Bounce scanning (P1 #10)
//
// Inbound DSN messages (RFC 3464 multipart/report) arrive in the sending
// mailbox a few minutes after a hard bounce. The cron-scan-bounces job calls
// listBounces() to pull recent ones and match them back to email_log rows
// via the original message's RFC 5322 Message-ID.
// ---------------------------------------------------------------------------

export interface InboxScanResult {
  /** Gmail's internal id for the DSN itself (not the bounced message). */
  gmailMessageId: string;
  /** RFC Message-ID of the original message that bounced (no brackets). */
  inReplyTo: string | null;
  /** RFC 3464 Final-Recipient header value (typically `rfc822;addr`). */
  finalRecipient: string | null;
  /** Diagnostic-Code line from the delivery-status part, trimmed. */
  failureReason: string | null;
  /** RFC 3464 Status code (e.g. "5.1.1" hard, "4.x.x" transient). */
  statusCode: string | null;
  /** When the DSN landed in our mailbox. */
  receivedAt: Date;
}

interface GmailHeader {
  name?: string | null;
  value?: string | null;
}

interface GmailPart {
  mimeType?: string | null;
  headers?: GmailHeader[] | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

interface GmailMessage {
  id?: string | null;
  internalDate?: string | null;
  payload?: GmailPart | null;
}

function getHeader(headers: GmailHeader[] | null | undefined, name: string): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === target) return h.value ?? null;
  }
  return null;
}

function decodeBase64Url(data: string): string {
  const pad = data.length % 4 === 0 ? '' : '='.repeat(4 - (data.length % 4));
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

function* walkParts(part: GmailPart | null | undefined): Generator<GmailPart> {
  if (!part) return;
  yield part;
  for (const child of part.parts ?? []) {
    yield* walkParts(child);
  }
}

/**
 * Parse the `message/delivery-status` part body. Format per RFC 3464 §2:
 * a sequence of "name: value" header lines, separated into per-message and
 * per-recipient groups by blank lines. We pull the first non-empty
 * Final-Recipient + Status + Diagnostic-Code values.
 */
function parseDeliveryStatus(body: string): {
  finalRecipient: string | null;
  statusCode: string | null;
  diagnostic: string | null;
} {
  const lines = body.split(/\r?\n/);
  let finalRecipient: string | null = null;
  let statusCode: string | null = null;
  let diagnostic: string | null = null;
  for (const line of lines) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (!m) continue;
    const name = m[1] ?? '';
    const value = (m[2] ?? '').trim();
    const lname = name.toLowerCase();
    if (!finalRecipient && lname === 'final-recipient') finalRecipient = value;
    else if (!statusCode && lname === 'status') statusCode = value;
    else if (!diagnostic && lname === 'diagnostic-code') diagnostic = value;
  }
  return { finalRecipient, statusCode, diagnostic };
}

/**
 * Build an InboxScanResult from a Gmail message resource (format=full).
 *
 * Strategy:
 *   1. `In-Reply-To` is taken from the DSN's own top-level headers; Gmail and
 *      most MTAs reflect the bounced message's Message-ID there. Fallback:
 *      walk the `message/rfc822` part (the embedded original) headers.
 *   2. Final-Recipient + Status + Diagnostic-Code come from the
 *      `message/delivery-status` part body, parsed as RFC 822-style headers.
 */
export function parseDsn(msg: GmailMessage): InboxScanResult {
  const payload = msg.payload ?? {};
  const topHeaders = payload.headers ?? [];

  let inReplyTo = getHeader(topHeaders, 'In-Reply-To');
  let deliveryStatusBody: string | null = null;
  let originalHeaders: GmailHeader[] | null = null;

  for (const p of walkParts(payload)) {
    const mt = (p.mimeType ?? '').toLowerCase();
    if (!deliveryStatusBody && mt === 'message/delivery-status' && p.body?.data) {
      deliveryStatusBody = decodeBase64Url(p.body.data);
    }
    if (!originalHeaders && (mt === 'message/rfc822' || mt === 'text/rfc822-headers')) {
      // Gmail nests the original message as a child part with its own headers.
      const child = (p.parts ?? [])[0];
      if (child?.headers) originalHeaders = child.headers;
      else if (p.headers) originalHeaders = p.headers;
    }
  }

  if (!inReplyTo && originalHeaders) {
    inReplyTo = getHeader(originalHeaders, 'Message-ID') ?? getHeader(originalHeaders, 'Message-Id');
  }
  if (inReplyTo) {
    inReplyTo = inReplyTo.trim().replace(/^<|>$/g, '');
  }

  let finalRecipient: string | null = null;
  let statusCode: string | null = null;
  let diagnostic: string | null = null;
  if (deliveryStatusBody) {
    ({ finalRecipient, statusCode, diagnostic } = parseDeliveryStatus(deliveryStatusBody));
  }

  const internalDate = msg.internalDate ? Number(msg.internalDate) : Date.now();

  return {
    gmailMessageId: msg.id ?? '',
    inReplyTo,
    finalRecipient,
    failureReason: diagnostic,
    statusCode,
    receivedAt: new Date(internalDate),
  };
}

/**
 * List DSN messages received in the sender mailbox since `since`. Returns
 * parsed metadata; does NOT mark messages as read or modify them.
 *
 * In dry-run (no GMAIL_SERVICE_ACCOUNT_KEY), returns []. The caller should
 * treat dry-run as "no bounces found" so the cron is a no-op locally.
 */
export async function listBounces(args: {
  since: Date;
  limit?: number;
}): Promise<InboxScanResult[]> {
  if (
    process.env.GMAIL_DRY_RUN === '1' ||
    !process.env.GMAIL_SERVICE_ACCOUNT_KEY
  ) {
    log.info('gmail_list_bounces_dry_run', { since: args.since.toISOString() });
    return [];
  }

  const key = await loadServiceAccountKey();
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    // Read access required for users.messages.list/get on the sending mailbox.
    // Domain-wide delegation in Workspace admin must include this scope OR the
    // call fails with `Insufficient Permission`. See docs/bounce-tracking.md.
    scopes: [GMAIL_READONLY_SCOPE],
    subject: SUBJECT_USER,
  });

  const gmail = google.gmail({ version: 'v1', auth });
  const sinceUnix = Math.floor(args.since.getTime() / 1000);
  // Gmail search query — `from:mailer-daemon` covers Gmail + most MTAs;
  // `OR from:postmaster` catches the rest. `after:<unix>` narrows to recent.
  const q = `(from:mailer-daemon OR from:postmaster) after:${sinceUnix}`;
  const list = await gmail.users.messages.list(
    { userId: 'me', q, maxResults: args.limit ?? 50 },
    { timeout: 10_000 },
  );
  const ids = (list.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string');

  const out: InboxScanResult[] = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get(
      { userId: 'me', id, format: 'full' },
      { timeout: 10_000 },
    );
    out.push(parseDsn(msg.data as GmailMessage));
  }

  log.info('gmail_list_bounces', {
    since: args.since.toISOString(),
    count: out.length,
  });
  return out;
}
