/**
 * /admin/clients/:id — minimal detail view.
 *
 * Renders: client + retreat snapshot, state, public client_token URL,
 * required consents w/ signed-or-not, recent audit events, recent emails.
 * Full M7 polish (edit / cancel / refund actions) lands later.
 *
 * Auth deferred (M8). Behind Cloud Run IAM auth in the meantime.
 */

import { Hono } from 'hono';
import { asc, desc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  auditEvents,
  clients,
  consentSignatures,
  consentTemplates,
  emailLog,
  locations,
  retreatRequiredConsents,
  retreats,
  therapists,
} from '../../db/schema.js';
import { getTemplate } from '../../lib/consent-templates.js';
import { formatCents } from '../../lib/pricing.js';

export const adminClientsDetailRoute = new Hono();

adminClientsDetailRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();

  const [row] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      clientToken: retreats.clientToken,
      plannedFullDays: retreats.plannedFullDays,
      plannedHalfDays: retreats.plannedHalfDays,
      paymentMethod: retreats.paymentMethod,
      pricingBasis: retreats.pricingBasis,
      pricingNotes: retreats.pricingNotes,
      fullDayRateCents: retreats.fullDayRateCents,
      halfDayRateCents: retreats.halfDayRateCents,
      depositCents: retreats.depositCents,
      totalPlannedCents: retreats.totalPlannedCents,
      scheduledStartDate: retreats.scheduledStartDate,
      scheduledEndDate: retreats.scheduledEndDate,
      createdAt: retreats.createdAt,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      clientEmail: clients.email,
      clientStateOfResidence: clients.stateOfResidence,
      therapistFullName: therapists.fullName,
      locationName: locations.name,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .innerJoin(therapists, eq(retreats.therapistId, therapists.id))
    .leftJoin(locations, eq(retreats.locationId, locations.id))
    .where(eq(retreats.id, id));

  if (!row) return c.notFound();

  const required = await db
    .select({
      templateId: retreatRequiredConsents.templateId,
      name: consentTemplates.name,
      requiresSignature: consentTemplates.requiresSignature,
    })
    .from(retreatRequiredConsents)
    .innerJoin(
      consentTemplates,
      eq(retreatRequiredConsents.templateId, consentTemplates.id),
    )
    .where(eq(retreatRequiredConsents.retreatId, id))
    .orderBy(asc(consentTemplates.name));

  const sigs = await db
    .select({
      templateId: consentSignatures.templateId,
      signedAt: consentSignatures.signedAt,
      pdfStoragePath: consentSignatures.pdfStoragePath,
    })
    .from(consentSignatures)
    .where(eq(consentSignatures.retreatId, id));
  const sigByTemplate = new Map(sigs.map((s) => [s.templateId, s]));

  const audits = await db
    .select({
      eventType: auditEvents.eventType,
      actorType: auditEvents.actorType,
      payload: auditEvents.payload,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(eq(auditEvents.retreatId, id))
    .orderBy(desc(auditEvents.createdAt))
    .limit(50);

  const emails = await db
    .select({
      recipient: emailLog.recipient,
      templateName: emailLog.templateName,
      gmailMessageId: emailLog.gmailMessageId,
      sentAt: emailLog.sentAt,
    })
    .from(emailLog)
    .where(eq(emailLog.retreatId, id))
    .orderBy(desc(emailLog.sentAt))
    .limit(20);

  const publicBase =
    process.env.PUBLIC_BASE_URL ?? `${c.req.url.split('/admin')[0]}`;
  const publicUrl = `${publicBase}/c/${row.clientToken}`;
  const consentsUrl = `${publicUrl}/consents`;

  const consentsList = required
    .map((r) => {
      const sig = sigByTemplate.get(r.templateId);
      const title = (() => {
        try {
          return getTemplate(r.name).meta.title;
        } catch {
          return r.name;
        }
      })();
      return `<li>${escHtml(title)} — ${
        r.requiresSignature
          ? sig
            ? `signed ${escHtml(sig.signedAt.toISOString())}${
                sig.pdfStoragePath
                  ? ` · <code>${escHtml(sig.pdfStoragePath)}</code>`
                  : ''
              }`
            : '<strong>not yet signed</strong>'
          : 'informational'
      }</li>`;
    })
    .join('');

  const depositPaid = audits.some((a) => a.eventType === 'deposit_paid');
  const showConfirmDates = row.state === 'awaiting_deposit' && depositPaid;

  const scheduleBlock = (() => {
    if (row.scheduledStartDate && row.scheduledEndDate) {
      return `<h2>Scheduled dates</h2>
  <div class="grid">
    <div>Start</div><div>${escHtml(row.scheduledStartDate)}</div>
    <div>End</div><div>${escHtml(row.scheduledEndDate)}</div>
  </div>`;
    }
    if (showConfirmDates) {
      return `<h2>Next step</h2>
  <p><a class="cta" href="/admin/clients/${escAttr(row.retreatId)}/confirm-dates">Confirm retreat dates</a></p>`;
    }
    return '';
  })();

  const completeBlock = (() => {
    if (row.state === 'in_progress') {
      return `<h2>Next step</h2>
  <p><a class="cta" href="/admin/clients/${escAttr(row.retreatId)}/complete">Complete retreat + charge balance</a></p>`;
    }
    if (row.state === 'final_charge_failed') {
      return `<h2 style="color:#a00">Final charge failed</h2>
  <p>Auto-retry runs at 24h then 72h cadence via the retry cron. Client recovery links:</p>
  <ul>
    <li>Update saved card (Stripe portal): <code>${escHtml(publicBase)}/c/${escHtml(row.clientToken)}/update-payment</code></li>
    <li>3DS hosted-confirmation page (only meaningful when last failure was <code>requires_action</code>): <code>${escHtml(publicBase)}/c/${escHtml(row.clientToken)}/confirm-payment</code></li>
  </ul>`;
    }
    return '';
  })();

  const auditList = audits
    .map((a) => {
      const payloadJson = a.payload ? JSON.stringify(a.payload) : '';
      return `<tr><td>${escHtml(a.createdAt.toISOString())}</td><td><code>${escHtml(a.eventType)}</code></td><td>${escHtml(a.actorType)}</td><td><code class="payload">${escHtml(payloadJson)}</code></td></tr>`;
    })
    .join('');

  const emailList = emails
    .map(
      (e) =>
        `<tr><td>${escHtml(e.sentAt.toISOString())}</td><td>${escHtml(e.templateName)}</td><td>${escHtml(e.recipient)}</td><td><code>${escHtml(e.gmailMessageId ?? '')}</code></td></tr>`,
    )
    .join('');

  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Retreat ${escHtml(row.retreatId.slice(0, 8))} — ITR Client HQ</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    h1, h2 { font-weight: 600; }
    .grid { display: grid; grid-template-columns: 200px 1fr; row-gap: 0.4rem; column-gap: 1rem; margin-bottom: 1.5rem; }
    .grid div:nth-child(odd) { color: #666; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
    th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
    th { background: #f6f6f6; font-weight: 600; }
    code { background: #f0f0f0; padding: 0 0.25rem; font: 12px ui-monospace, monospace; }
    code.payload { display: inline-block; max-width: 460px; white-space: pre-wrap; word-break: break-all; }
    a.cta { display: inline-block; padding: 0.4rem 0.8rem; background: #1c4f7c; color: white; text-decoration: none; border-radius: 4px; }
    .topnav { color: #666; margin-bottom: 1rem; }
    .topnav a { color: #1c4f7c; text-decoration: none; margin-right: 0.6rem; }
  </style>
</head>
<body>
  <p class="topnav"><a href="/admin">← Dashboard</a> · <a href="/admin/clients/${escAttr(row.retreatId)}/refund">Refund</a></p>
  <h1>Retreat <code>${escHtml(row.retreatId)}</code></h1>
  <p><strong>State:</strong> <code>${escHtml(row.state)}</code></p>

  <h2>Public client URL</h2>
  <p><a class="cta" href="${escAttr(publicUrl)}" target="_blank">${escHtml(publicUrl)}</a></p>
  <p>Sign flow: <a href="${escAttr(consentsUrl)}" target="_blank">${escHtml(consentsUrl)}</a></p>

  <h2>Client + therapist</h2>
  <div class="grid">
    <div>Client</div><div>${escHtml(row.clientFirstName)} ${escHtml(row.clientLastName)} &lt;${escHtml(row.clientEmail)}&gt;</div>
    <div>State of residence</div><div>${escHtml(row.clientStateOfResidence ?? '—')}</div>
    <div>Therapist</div><div>${escHtml(row.therapistFullName)}</div>
    <div>Location</div><div>${escHtml(row.locationName ?? '—')}</div>
  </div>

  <h2>Pricing</h2>
  <div class="grid">
    <div>Basis</div><div>${escHtml(row.pricingBasis)}</div>
    <div>Payment method</div><div>${escHtml(row.paymentMethod)}</div>
    <div>Full day rate</div><div>${formatCents(row.fullDayRateCents)} × ${row.plannedFullDays}</div>
    <div>Half day rate</div><div>${row.halfDayRateCents == null ? '—' : `${formatCents(row.halfDayRateCents)} × ${row.plannedHalfDays}`}</div>
    <div>Total planned</div><div>${formatCents(row.totalPlannedCents)}</div>
    <div>Deposit</div><div>${formatCents(row.depositCents)}</div>
    <div>Pricing notes</div><div>${escHtml(row.pricingNotes ?? '')}</div>
  </div>

  ${scheduleBlock}
  ${completeBlock}

  <h2>Required consents</h2>
  <ul>${consentsList}</ul>

  <h2>Audit log</h2>
  <table><thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Payload</th></tr></thead><tbody>${auditList}</tbody></table>

  <h2>Email log</h2>
  <table><thead><tr><th>When</th><th>Template</th><th>Recipient</th><th>Gmail message id</th></tr></thead><tbody>${emailList}</tbody></table>
</body>
</html>`);
});

function escHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escAttr(s: string): string {
  return escHtml(s).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
