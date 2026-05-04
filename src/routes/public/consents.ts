/**
 * Public client surface — token-gated, no auth (DESIGN.md §10).
 *
 * Routes:
 *   GET  /c/:token                 status / "what's next"
 *   GET  /c/:token/consents        next unsigned required template
 *   POST /c/:token/consents        record a signature, render PDF, upload,
 *                                  advance to next (or to awaiting_deposit
 *                                  via state-machine.markConsentsSigned)
 *
 * Token leakage protection:
 *   - Routes return 404 (not 403) for unknown tokens — no probing oracle.
 *   - The token never appears in audit_event payloads or email_log.
 *
 * Signature capture is plain HTML5 canvas + a tiny inline JS shim.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { asc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  clients,
  consentSignatures,
  consentTemplates,
  pricingConfig,
  retreatRequiredConsents,
  retreats,
  therapists,
} from '../../db/schema.js';
import {
  getTemplate,
  type RequiredField as TemplateRequiredField,
} from '../../lib/consent-templates.js';
import { renderConsentPdf, type IntakeAnswer } from '../../lib/pdf.js';
import { formatCents } from '../../lib/pricing.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';
import {
  decodeSignatureDataUrl,
  uploadConsentPdf,
  uploadSignatureImage,
} from '../../lib/storage.js';

export const publicConsentsRoute = new Hono();

interface RetreatContext {
  retreatId: string;
  retreatState: string;
  clientId: string;
  clientFirstName: string;
  clientToken: string;
  therapistFullName: string;
  fullDayRateCents: number;
  halfDayRateCents: number | null;
  depositCents: number;
  achDiscountPct: number;
  affirmUpliftPct: number;
  cancellationAdminFeeCents: number;
}

async function loadByToken(token: string): Promise<RetreatContext | null> {
  const { db } = await getDb();
  const [row] = await db
    .select({
      retreatId: retreats.id,
      retreatState: retreats.state,
      clientId: retreats.clientId,
      clientToken: retreats.clientToken,
      fullDayRateCents: retreats.fullDayRateCents,
      halfDayRateCents: retreats.halfDayRateCents,
      depositCents: retreats.depositCents,
      achDiscountPct: retreats.achDiscountPct,
      clientFirstName: clients.firstName,
      therapistFullName: therapists.fullName,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .innerJoin(therapists, eq(retreats.therapistId, therapists.id))
    .where(eq(retreats.clientToken, token));
  if (!row) return null;

  const [pc] = await db.select().from(pricingConfig).where(eq(pricingConfig.id, 'singleton'));
  return {
    retreatId: row.retreatId,
    retreatState: row.retreatState,
    clientId: row.clientId,
    clientFirstName: row.clientFirstName,
    clientToken: row.clientToken,
    therapistFullName: row.therapistFullName,
    fullDayRateCents: row.fullDayRateCents,
    halfDayRateCents: row.halfDayRateCents,
    depositCents: row.depositCents,
    achDiscountPct: Number(row.achDiscountPct),
    affirmUpliftPct: pc ? Number(pc.affirmUpliftPct) : 0.1,
    cancellationAdminFeeCents: pc ? pc.cancellationAdminFeeCents : 10_000,
  };
}

publicConsentsRoute.get('/:token', async (c) => {
  const token = c.req.param('token');
  const ctx = await loadByToken(token);
  if (!ctx) return c.notFound();

  const { db } = await getDb();
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
    .where(eq(retreatRequiredConsents.retreatId, ctx.retreatId))
    .orderBy(asc(consentTemplates.name));

  const signed = await db
    .select({ templateId: consentSignatures.templateId })
    .from(consentSignatures)
    .where(eq(consentSignatures.retreatId, ctx.retreatId));
  const signedSet = new Set(signed.map((s) => s.templateId));

  const items = required.map((r) => ({
    name: r.name,
    title: getTemplate(r.name).meta.title,
    requiresSignature: r.requiresSignature,
    signed: signedSet.has(r.templateId),
  }));
  return c.html(renderStatusPage({ ctx, items }));
});

publicConsentsRoute.get('/:token/consents', async (c) => {
  const token = c.req.param('token');
  const ctx = await loadByToken(token);
  if (!ctx) return c.notFound();
  if (ctx.retreatState !== 'awaiting_consents') {
    return c.redirect(`/c/${token}`);
  }

  const next = await loadNextUnsigned(ctx.retreatId);
  if (!next) return c.redirect(`/c/${token}`);

  return c.html(renderSignPage({ ctx, template: next, token }));
});

// 1 MB cap on the consent submission (M9 fix #10). The signature
// data URL is the heaviest field (~50–250 KB for a typical canvas
// signature); 1 MB leaves headroom for free-text fields without
// letting an attacker exhaust the 512 MiB Cloud Run instance.
publicConsentsRoute.post('/:token/consents', bodyLimit({
  maxSize: 1_048_576,
  onError: (c) => c.json({ error: 'payload_too_large' }, 413),
}), async (c) => {
  const token = c.req.param('token');
  const ctx = await loadByToken(token);
  if (!ctx) return c.notFound();
  if (ctx.retreatState !== 'awaiting_consents') {
    return c.redirect(`/c/${token}`);
  }

  const next = await loadNextUnsigned(ctx.retreatId);
  if (!next) return c.redirect(`/c/${token}`);

  const form = await c.req.formData();
  const get = (k: string) => (form.get(k) as string | null) ?? '';

  const signatureDataUrl = get('signature_data_url');
  const signedName = get('signed_name').trim();
  if (next.requiresSignature) {
    if (!signatureDataUrl || !signedName) {
      return c.json({ error: 'signature_required' }, 400);
    }
  }

  // Build evidence_blob from required_fields, capturing exactly the keys the
  // template declared and nothing else.
  const evidence: Record<string, unknown> = {};
  for (const field of next.requiredFields) {
    const v = form.get(field.key);
    evidence[field.key] = v ?? null;
  }
  if (signatureDataUrl) evidence['signature_data_url'] = signatureDataUrl;

  const { db } = await getDb();
  const [sig] = await db
    .insert(consentSignatures)
    .values({
      retreatId: ctx.retreatId,
      templateId: next.templateId,
      signedName: signedName || ctx.clientFirstName,
      signedAt: new Date(),
      ipAddress:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
      userAgent: c.req.header('user-agent') || null,
      evidenceBlob: evidence,
    })
    .returning({ id: consentSignatures.id });
  if (!sig) throw new Error('signature insert failed');

  // Render + upload the signed PDF (separate raw signature image too).
  try {
    const intakeAnswers: IntakeAnswer[] = next.requiredFields
      .filter((f) => f.kind !== 'signature')
      .map((f) => ({
        field: f as TemplateRequiredField,
        value: stringifyAnswer(form.get(f.key)),
      }));

    const pdfBuf = await renderConsentPdf({
      templateName: next.name,
      vars: buildTemplateVars(ctx),
      intakeAnswers,
      ...(signatureDataUrl
        ? {
            signature: {
              signatureDataUrl,
              signedName: signedName || ctx.clientFirstName,
              signedAt: new Date(),
            },
          }
        : {}),
    });

    const upload = await uploadConsentPdf({
      retreatId: ctx.retreatId,
      templateName: next.name,
      templateVersion: next.version,
      signatureId: sig.id,
      pdf: pdfBuf,
    });

    if (signatureDataUrl) {
      const png = decodeSignatureDataUrl(signatureDataUrl);
      await uploadSignatureImage({
        retreatId: ctx.retreatId,
        signatureId: sig.id,
        png,
      });
    }

    await db
      .update(consentSignatures)
      .set({ pdfStoragePath: upload.storagePath })
      .where(eq(consentSignatures.id, sig.id));
  } catch (err) {
    // Non-fatal: signature is recorded; render/upload can be retried later
    // by an admin tool (M7). Surface in logs but do not 500 — the client
    // already signed.
    log.error('consent_pdf_upload_failed', {
      retreatId: ctx.retreatId,
      signatureId: sig.id,
      error: (err as Error).message,
    });
  }

  // If this was the last required signature, transition.
  const remaining = await loadNextUnsigned(ctx.retreatId);
  if (!remaining) {
    await transitions.markConsentsSigned({
      retreatId: ctx.retreatId,
      actor: { kind: 'client', token },
    });
  }

  return c.redirect(`/c/${token}`);
});

interface UnsignedTemplate {
  templateId: string;
  name: string;
  version: number;
  title: string;
  bodyMarkdown: string;
  requiresSignature: boolean;
  requiredFields: TemplateRequiredField[];
}

async function loadNextUnsigned(retreatId: string): Promise<UnsignedTemplate | null> {
  const { db } = await getDb();
  const required = await db
    .select({
      templateId: retreatRequiredConsents.templateId,
      name: consentTemplates.name,
      version: consentTemplates.version,
      bodyMarkdown: consentTemplates.bodyMarkdown,
      requiresSignature: consentTemplates.requiresSignature,
      requiredFields: consentTemplates.requiredFields,
    })
    .from(retreatRequiredConsents)
    .innerJoin(
      consentTemplates,
      eq(retreatRequiredConsents.templateId, consentTemplates.id),
    )
    .where(eq(retreatRequiredConsents.retreatId, retreatId))
    .orderBy(asc(consentTemplates.name));

  const signed = await db
    .select({ templateId: consentSignatures.templateId })
    .from(consentSignatures)
    .where(eq(consentSignatures.retreatId, retreatId));
  const signedSet = new Set(signed.map((s) => s.templateId));

  // Only signature-required templates participate in the signing queue.
  // Informational templates (requires_signature=false, e.g. the Notice of
  // Privacy Practices) live on the status list but never gate progression
  // to awaiting_deposit.
  const next = required.find(
    (r) => r.requiresSignature && !signedSet.has(r.templateId),
  );
  if (!next) return null;
  return {
    ...next,
    title: getTemplate(next.name).meta.title,
    requiredFields: (next.requiredFields ?? []) as TemplateRequiredField[],
  };
}

function buildTemplateVars(ctx: RetreatContext): Record<string, string> {
  const halfDayAffirm =
    ctx.halfDayRateCents == null
      ? ''
      : formatCents(Math.round(ctx.halfDayRateCents * (1 + ctx.affirmUpliftPct)));
  return {
    therapist_name: ctx.therapistFullName,
    full_day_rate_formatted: formatCents(ctx.fullDayRateCents),
    half_day_rate_formatted:
      ctx.halfDayRateCents == null ? '' : formatCents(ctx.halfDayRateCents),
    half_day_rate_affirm_formatted: halfDayAffirm,
    affirm_uplift_pct_formatted: `${(ctx.affirmUpliftPct * 100).toFixed(0)}%`,
    deposit_rate_formatted: formatCents(ctx.depositCents),
    cancellation_admin_fee_formatted: formatCents(ctx.cancellationAdminFeeCents),
    npp_version_label: 'v1, effective 2020-07-14',
  };
}

function stringifyAnswer(v: string | File | null): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : '[file]';
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────────────────────────────────────

function renderStatusPage(args: {
  ctx: RetreatContext;
  items: { name: string; title: string; requiresSignature: boolean; signed: boolean }[];
}): string {
  const { ctx, items } = args;
  const allSigned = items.every((i) => !i.requiresSignature || i.signed);
  const next = items.find((i) => i.requiresSignature && !i.signed);

  const list = items
    .map(
      (i) =>
        `<li>${escHtml(i.title)} ${
          i.requiresSignature
            ? i.signed
              ? '✓ signed'
              : '— not yet signed'
            : '(informational)'
        }</li>`,
    )
    .join('');

  let nextStep = '';
  switch (ctx.retreatState) {
    case 'awaiting_consents':
      nextStep = next
        ? `<p><a class="cta" href="/c/${escAttr(ctx.clientToken)}/consents">Continue with ${escHtml(next.title)}</a></p>`
        : '<p>All consents are signed. We are preparing your deposit checkout — you will receive a follow-up email.</p>';
      break;
    case 'awaiting_deposit':
      nextStep = '<p>All consents are signed. Deposit checkout link is coming next.</p>';
      break;
    case 'scheduled':
      nextStep = '<p>Your retreat is scheduled. See you soon.</p>';
      break;
    default:
      nextStep = `<p>Status: ${escHtml(ctx.retreatState)}.</p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Your retreat — Intensive Therapy Retreats</title>
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { font-weight: 600; }
    ul { padding-left: 1.2rem; }
    a.cta { display: inline-block; padding: 0.6rem 1rem; background: #1c4f7c; color: white; text-decoration: none; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Hi ${escHtml(ctx.clientFirstName)},</h1>
  <p>Your therapist is <strong>${escHtml(ctx.therapistFullName)}</strong>.</p>
  <h2>Required documents</h2>
  <ul>${list}</ul>
  ${nextStep}
  <p style="margin-top:2rem;color:#666;font-size:13px">All ${allSigned ? 'consents are' : 'documents will be'} stored securely and you will receive a copy when complete.</p>
</body>
</html>`;
}

function renderSignPage(args: {
  ctx: RetreatContext;
  template: UnsignedTemplate;
  token: string;
}): string {
  const { ctx, template, token } = args;

  // Render the signed body markdown for client display, with vars filled in.
  // We display the raw markdown — paragraphs split on blank lines — rather
  // than HTML-rendering it; the canonical PDF is the legal artifact.
  const escapedBody = escHtml(template.bodyMarkdown).replace(/\n\n+/g, '\n\n').trim();

  const fields = template.requiredFields.map((f) => renderField(f)).join('');

  const sigPad = template.requiresSignature ? renderSignaturePad() : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escHtml(template.title)} — Intensive Therapy Retreats</title>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { font-weight: 600; }
    pre.body { white-space: pre-wrap; background: #f7f7f7; padding: 1rem; max-height: 380px; overflow: auto; border: 1px solid #e0e0e0; }
    fieldset { border: 1px solid #ddd; padding: 1rem 1.2rem; margin: 1rem 0; }
    label { display: block; margin-bottom: 0.6rem; }
    label span.lbl { display: inline-block; min-width: 280px; vertical-align: top; }
    input[type=text], input[type=email], input[type=date], textarea, select { padding: 0.4rem; font: inherit; min-width: 240px; }
    textarea { vertical-align: top; height: 4rem; min-width: 360px; }
    button { padding: 0.6rem 1rem; cursor: pointer; }
    canvas { border: 1px solid #888; touch-action: none; background: white; }
    .sig-row { display: flex; gap: 0.5rem; align-items: flex-end; }
  </style>
</head>
<body>
  <h1>${escHtml(template.title)}</h1>
  <p>Therapist: <strong>${escHtml(ctx.therapistFullName)}</strong></p>
  <pre class="body">${escapedBody}</pre>
  <form method="post">
    <fieldset>
      <legend>Required information</legend>
      ${fields}
    </fieldset>
    ${sigPad}
    <button type="submit">${template.requiresSignature ? 'Sign and continue' : 'Acknowledge and continue'}</button>
  </form>
  <p style="margin-top:1rem;font-size:12px;color:#666">Token: ${escHtml(token.slice(0, 4))}…</p>
</body>
</html>`;
}

function renderField(f: TemplateRequiredField): string {
  const required = f.required ? ' required' : '';
  const id = `f_${f.key}`;
  switch (f.kind) {
    case 'text':
      return `<label><span class="lbl">${escHtml(f.label)}</span><input id="${id}" name="${escAttr(f.key)}" type="text"${required}></label>`;
    case 'longtext':
      return `<label><span class="lbl">${escHtml(f.label)}</span><textarea id="${id}" name="${escAttr(f.key)}"${required}></textarea></label>`;
    case 'date':
      return `<label><span class="lbl">${escHtml(f.label)}</span><input id="${id}" name="${escAttr(f.key)}" type="date"${required}></label>`;
    case 'yesno':
      return `<label><span class="lbl">${escHtml(f.label)}</span><select id="${id}" name="${escAttr(f.key)}"${required}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select></label>`;
    case 'checkbox':
      return `<label><span class="lbl">${escHtml(f.label)}</span><input id="${id}" name="${escAttr(f.key)}" type="checkbox" value="yes"${required}></label>`;
    case 'choice_multi': {
      const opts = (f.options ?? [])
        .map(
          (o) =>
            `<label style="display:inline-block;min-width:160px;margin-right:0.5rem"><input type="checkbox" name="${escAttr(f.key)}" value="${escAttr(o)}"> ${escHtml(o)}</label>`,
        )
        .join('');
      return `<div style="margin-bottom:0.8rem"><div style="font-weight:500;margin-bottom:0.3rem">${escHtml(f.label)}</div>${opts}</div>`;
    }
    case 'signature':
      // Signature pad rendered separately at the end of the form.
      return '';
  }
}

function renderSignaturePad(): string {
  return `
    <fieldset>
      <legend>Signature</legend>
      <p>Sign in the box below using your mouse or finger.</p>
      <div class="sig-row">
        <canvas id="sig-pad" width="480" height="160"></canvas>
        <button type="button" id="sig-clear">Clear</button>
      </div>
      <input type="hidden" name="signature_data_url" id="signature_data_url" required>
      <label style="margin-top:0.6rem"><span class="lbl">Printed name</span><input name="signed_name" type="text" required></label>
    </fieldset>
    <script>
    (function(){
      var c = document.getElementById('sig-pad');
      var ctx = c.getContext('2d');
      var hidden = document.getElementById('signature_data_url');
      var drawing = false;
      var dirty = false;
      var last = null;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#111';
      function pos(e){
        var r = c.getBoundingClientRect();
        var t = (e.touches ? e.touches[0] : e);
        return { x: t.clientX - r.left, y: t.clientY - r.top };
      }
      function start(e){ e.preventDefault(); drawing = true; last = pos(e); }
      function move(e){
        if (!drawing) return; e.preventDefault();
        var p = pos(e);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last = p; dirty = true;
        hidden.value = c.toDataURL('image/png');
      }
      function end(){ drawing = false; }
      c.addEventListener('mousedown', start);
      c.addEventListener('mousemove', move);
      c.addEventListener('mouseup', end);
      c.addEventListener('mouseleave', end);
      c.addEventListener('touchstart', start);
      c.addEventListener('touchmove', move);
      c.addEventListener('touchend', end);
      document.getElementById('sig-clear').addEventListener('click', function(){
        ctx.clearRect(0,0,c.width,c.height); dirty = false; hidden.value = '';
      });
    })();
    </script>
  `;
}

function escHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escAttr(s: string): string {
  return escHtml(s).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

