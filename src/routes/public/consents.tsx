/**
 * Public client surface — token-gated, no auth (DESIGN.md §10).
 *
 *   GET  /c/:token                 status / "what's next"
 *   GET  /c/:token/consents        next unsigned required template
 *   POST /c/:token/consents        record signature, render PDF, advance
 *
 * Token leakage protection:
 *   - Routes return 404 (not 403) for unknown tokens — no probing oracle.
 *   - The token never appears in audit_event payloads or email_log.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { raw } from 'hono/html';
import { and, asc, eq } from 'drizzle-orm';
import { marked } from 'marked';

import { getDb } from '../../db/client.js';
import {
  auditEvents,
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
  substitute,
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
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ClientShell,
  Field,
  Input,
  Label,
  Layout,
  LinkButton,
  Select,
  Textarea,
} from '../../lib/ui/index.js';

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
    .innerJoin(consentTemplates, eq(retreatRequiredConsents.templateId, consentTemplates.id))
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
  const next = items.find((i) => i.requiresSignature && !i.signed);
  const allSigned = items.every((i) => !i.requiresSignature || i.signed);

  let nextStep: unknown;
  switch (ctx.retreatState) {
    case 'awaiting_consents':
      nextStep = next ? (
        <LinkButton href={`/c/${ctx.clientToken}/consents`} size="lg">
          Continue with {next.title}
        </LinkButton>
      ) : (
        <p class="text-sm text-muted-foreground">
          All consents are signed. We are preparing your deposit checkout — you will receive a follow-up
          email.
        </p>
      );
      break;
    case 'awaiting_deposit':
      nextStep = (
        <p class="text-sm text-muted-foreground">
          All consents are signed. Deposit checkout link is coming next.
        </p>
      );
      break;
    case 'scheduled':
      nextStep = (
        <p class="text-sm text-muted-foreground">Your retreat is scheduled. See you soon.</p>
      );
      break;
    default:
      nextStep = (
        <p class="text-sm text-muted-foreground">
          Status: <code class="font-mono">{ctx.retreatState}</code>
        </p>
      );
  }

  return c.html(
    <Layout title="Your retreat — Intensive Therapy Retreats">
      <ClientShell>
        <h1 class="text-2xl font-semibold tracking-tight mb-2">Hi {ctx.clientFirstName},</h1>
        <p class="text-muted-foreground mb-6">
          Your therapist is <strong class="text-foreground">{ctx.therapistFullName}</strong>.
        </p>

        <Card class="mb-6">
          <CardHeader>
            <CardTitle>Required documents</CardTitle>
          </CardHeader>
          <CardContent>
            <ul class="space-y-3">
              {items.map((i) => (
                <li class="flex items-center justify-between gap-3 text-sm">
                  <a
                    href={`/c/${ctx.clientToken}/view/${i.name}`}
                    class="text-primary underline-offset-4 hover:underline"
                  >
                    {i.title}
                  </a>
                  {i.requiresSignature ? (
                    i.signed ? (
                      <Badge variant="success">✓ signed</Badge>
                    ) : (
                      <Badge variant="secondary">not yet signed</Badge>
                    )
                  ) : (
                    <Badge variant="outline">informational</Badge>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div class="mb-6">{nextStep}</div>

        <p class="text-xs text-muted-foreground">
          All {allSigned ? 'consents are' : 'documents will be'} stored securely and you will receive a
          copy when complete.
        </p>
      </ClientShell>
    </Layout>,
  );
});

/** Read-only view of any consent template attached to this retreat.
 * Used for informational templates (Notice of Privacy Practices) and to
 * let clients re-read a signed document at any time. No form, no submit.
 * Returns 404 if the template isn't attached to this retreat — keeps
 * the route from acting as a generic content-discovery oracle. */
publicConsentsRoute.get('/:token/view/:templateName', async (c) => {
  const token = c.req.param('token');
  const templateName = c.req.param('templateName');
  const ctx = await loadByToken(token);
  if (!ctx) return c.notFound();

  const { db } = await getDb();
  const required = await db
    .select({
      templateId: consentTemplates.id,
      name: consentTemplates.name,
      body: consentTemplates.bodyMarkdown,
    })
    .from(retreatRequiredConsents)
    .innerJoin(consentTemplates, eq(retreatRequiredConsents.templateId, consentTemplates.id))
    .where(eq(retreatRequiredConsents.retreatId, ctx.retreatId));

  const tpl = required.find((r) => r.name === templateName);
  if (!tpl) return c.notFound();

  let title = templateName;
  try {
    title = getTemplate(templateName).meta.title;
  } catch {
    /* fall back to raw name */
  }

  // Pull the signature for this template (if any) so we can render it inline.
  const [sig] = await db
    .select({
      signedName: consentSignatures.signedName,
      signedAt: consentSignatures.signedAt,
      evidenceBlob: consentSignatures.evidenceBlob,
    })
    .from(consentSignatures)
    .where(
      and(
        eq(consentSignatures.retreatId, ctx.retreatId),
        eq(consentSignatures.templateId, tpl.templateId),
      ),
    );

  const evidence = (sig?.evidenceBlob ?? {}) as Record<string, unknown>;
  const sigDataUrl =
    typeof evidence['signature_data_url'] === 'string'
      ? (evidence['signature_data_url'] as string)
      : null;
  const sigMethod =
    typeof evidence['signature_method'] === 'string'
      ? (evidence['signature_method'] as string)
      : sigDataUrl
        ? 'drawn'
        : 'typed';

  const substituted = substitute(tpl.body, buildTemplateVars(ctx));
  const bodyHtml = marked.parse(substituted, { async: false }) as string;

  return c.html(
    <Layout title={`${title} — Intensive Therapy Retreats`}>
      <ClientShell width="xl">
        <h1 class="text-2xl font-semibold tracking-tight mb-2">{title}</h1>
        <p class="text-sm text-muted-foreground mb-4">
          Therapist: <strong class="text-foreground">{ctx.therapistFullName}</strong>
        </p>

        <Card class="mb-6">
          <CardContent class="pt-6">
            <div class={CONSENT_PROSE_CLASS}>{raw(bodyHtml)}</div>
          </CardContent>
        </Card>

        {sig ? (
          <Card class="mb-6">
            <CardHeader>
              <CardTitle>Signature</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3">
              <dl class="grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
                <dt class="text-muted-foreground">Signed by</dt>
                <dd class="font-medium">{sig.signedName}</dd>
                <dt class="text-muted-foreground">Date</dt>
                <dd>{sig.signedAt.toISOString().slice(0, 10)}</dd>
                <dt class="text-muted-foreground">Method</dt>
                <dd class="text-sm">
                  {sigMethod === 'drawn' ? 'Drawn signature' : 'Typed attestation (ESIGN Act)'}
                </dd>
              </dl>
              {sigDataUrl ? (
                <img
                  src={sigDataUrl}
                  alt={`Signature of ${sig.signedName}`}
                  class="border border-input rounded-md bg-white max-w-md"
                />
              ) : (
                <p class="text-sm text-muted-foreground italic">
                  No drawn signature on file. Typed attestation recorded.
                </p>
              )}
            </CardContent>
          </Card>
        ) : null}

        <LinkButton href={`/c/${token}`} variant="outline">
          ← Back to retreat status
        </LinkButton>
      </ClientShell>
    </Layout>,
  );
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

  // Substitute {{var}} placeholders, then render markdown → HTML.
  // marked.parse() returns string by default in v18 unless { async: true }.
  const substituted = substitute(next.bodyMarkdown, buildTemplateVars(ctx));
  const bodyHtml = marked.parse(substituted, { async: false }) as string;

  return c.html(
    <Layout title={`${next.title} — Intensive Therapy Retreats`}>
      <ClientShell width="xl">
        <h1 class="text-2xl font-semibold tracking-tight mb-2">{next.title}</h1>
        <p class="text-sm text-muted-foreground mb-4">
          Therapist: <strong class="text-foreground">{ctx.therapistFullName}</strong>
        </p>

        <Card class="mb-6">
          <CardContent class="pt-6">
            <div class={CONSENT_PROSE_CLASS}>{raw(bodyHtml)}</div>
          </CardContent>
        </Card>

        <form method="post" class="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Required information</CardTitle>
            </CardHeader>
            <CardContent class="space-y-6">
              {next.requiredFields.map((f) => (
                <FieldFromTemplate field={f} />
              ))}
            </CardContent>
          </Card>

          {next.requiresSignature ? <SignaturePad /> : null}

          <div class="flex justify-end">
            <Button type="submit" size="lg">
              {next.requiresSignature ? 'Sign and continue' : 'Acknowledge and continue'}
            </Button>
          </div>
        </form>
      </ClientShell>
    </Layout>,
  );
});

// Tailwind arbitrary-variant classes that style the rendered consent body.
// Keeps us off `@tailwindcss/typography` (no extra dep) at the cost of a
// long string per-render; CSS is in the static bundle anyway.
const CONSENT_PROSE_CLASS = [
  'text-sm leading-relaxed max-h-[28rem] overflow-auto pr-2',
  '[&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mt-0 [&_h1]:mb-3',
  '[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2',
  '[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2',
  '[&_p]:mb-3',
  '[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-3 [&_ul]:space-y-1',
  '[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-3 [&_ol]:space-y-1',
  '[&_li]:leading-relaxed',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_em]:italic',
  '[&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline',
  '[&_hr]:my-4 [&_hr]:border-border',
  '[&_code]:font-mono [&_code]:text-xs [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded',
].join(' ');

publicConsentsRoute.post(
  '/:token/consents',
  bodyLimit({
    maxSize: 1_048_576,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
  async (c) => {
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
    const attestationTyped = get('attestation_typed') === 'yes';
    // a11y P2#12: typed-attestation alternative for users who can't use the
    // canvas pad. Either drawn signature OR (typed name + attest checkbox)
    // satisfies requires_signature. ESIGN-Act-style — typed name + audit
    // trail (IP, UA, timestamp, evidence_blob) is a valid e-sig.
    if (next.requiresSignature) {
      if (!signedName) {
        return c.json({ error: 'signed_name_required' }, 400);
      }
      if (!signatureDataUrl && !attestationTyped) {
        return c.json({ error: 'signature_or_attestation_required' }, 400);
      }
    }
    if (signedName.length > 200) {
      return c.json({ error: 'signed_name_too_long' }, 400);
    }

    const evidence: Record<string, unknown> = {};
    for (const field of next.requiredFields) {
      const v = form.get(field.key);
      evidence[field.key] = v ?? null;
    }
    if (signatureDataUrl) evidence['signature_data_url'] = signatureDataUrl;
    evidence['signature_method'] = signatureDataUrl ? 'drawn' : 'typed';
    if (!signatureDataUrl) evidence['typed_attestation'] = true;

    const { db } = await getDb();
    const [sig] = await db
      .insert(consentSignatures)
      .values({
        retreatId: ctx.retreatId,
        templateId: next.templateId,
        signedName: signedName || ctx.clientFirstName,
        signedAt: new Date(),
        ipAddress: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
        userAgent: c.req.header('user-agent') || null,
        evidenceBlob: evidence,
      })
      .returning({ id: consentSignatures.id });
    if (!sig) throw new Error('signature insert failed');

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
      log.error('consent_pdf_upload_failed', {
        retreatId: ctx.retreatId,
        signatureId: sig.id,
        error: (err as Error).message,
      });
      await db
        .insert(auditEvents)
        .values({
          retreatId: ctx.retreatId,
          actorType: 'system',
          actorId: null,
          eventType: 'pdf_upload_failed',
          payload: {
            signature_id: sig.id,
            template_name: next.name,
            template_version: next.version,
            error: (err as Error).message.slice(0, 200),
          },
        })
        .catch((auditErr: unknown) => {
          log.error('pdf_upload_failed_audit_write_failed', {
            retreatId: ctx.retreatId,
            signatureId: sig.id,
            pdfError: (err as Error).message,
            auditError: (auditErr as Error).message,
          });
        });
    }

    const remaining = await loadNextUnsigned(ctx.retreatId);
    if (!remaining) {
      await transitions.markConsentsSigned({
        retreatId: ctx.retreatId,
        actor: { kind: 'client', token },
      });
    }

    return c.redirect(`/c/${token}`);
  },
);

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
    .innerJoin(consentTemplates, eq(retreatRequiredConsents.templateId, consentTemplates.id))
    .where(eq(retreatRequiredConsents.retreatId, retreatId))
    .orderBy(asc(consentTemplates.name));

  const signed = await db
    .select({ templateId: consentSignatures.templateId })
    .from(consentSignatures)
    .where(eq(consentSignatures.retreatId, retreatId));
  const signedSet = new Set(signed.map((s) => s.templateId));

  const next = required.find((r) => r.requiresSignature && !signedSet.has(r.templateId));
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

function FieldFromTemplate({ field: f }: { field: TemplateRequiredField }) {
  const id = `f_${f.key}`;
  switch (f.kind) {
    case 'text':
      return (
        <Field label={f.label} for={id}>
          <Input id={id} name={f.key} type="text" required={f.required} />
        </Field>
      );
    case 'longtext':
      return (
        <Field label={f.label} for={id}>
          <Textarea id={id} name={f.key} required={f.required} rows={3} />
        </Field>
      );
    case 'date':
      return (
        <Field label={f.label} for={id}>
          <Input id={id} name={f.key} type="date" required={f.required} />
        </Field>
      );
    case 'yesno':
      return (
        <Field label={f.label} for={id}>
          <Select id={id} name={f.key} required={f.required}>
            <option value="">—</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </Field>
      );
    case 'checkbox':
      return (
        <label class="flex items-start gap-2 text-sm">
          <input
            id={id}
            name={f.key}
            type="checkbox"
            value="yes"
            required={f.required}
            class="mt-0.5 h-4 w-4 rounded border-input"
          />
          <span>{f.label}</span>
        </label>
      );
    case 'choice_multi':
      return (
        <div class="space-y-2">
          <Label>{f.label}</Label>
          <div class="flex flex-wrap gap-x-4 gap-y-2">
            {(f.options ?? []).map((o) => (
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name={f.key}
                  value={o}
                  class="h-4 w-4 rounded border-input"
                />
                <span>{o}</span>
              </label>
            ))}
          </div>
        </div>
      );
    case 'signature':
      return null;
  }
}

function SignaturePad() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Signature</CardTitle>
      </CardHeader>
      <CardContent class="space-y-4">
        <p class="text-sm text-muted-foreground">
          Sign in the box below using your mouse or finger. If you can't draw
          (using a keyboard, screen reader, or accessible input device), check
          the typed-attestation box at the bottom and your typed name will be
          your electronic signature under the ESIGN Act.
        </p>
        <div class="flex flex-wrap items-end gap-3">
          <canvas
            id="sig-pad"
            width="480"
            height="160"
            aria-label="Signature pad. If you cannot use this, check the typed-attestation box below."
            class="border border-input rounded-md bg-white touch-none"
          />
          <Button type="button" id="sig-clear" variant="outline" size="sm">
            Clear
          </Button>
        </div>
        <input type="hidden" name="signature_data_url" id="signature_data_url" />
        <Field label="Printed name (required)" for="signed_name">
          <Input id="signed_name" name="signed_name" type="text" required />
        </Field>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="attestation_typed"
            value="yes"
            class="mt-0.5 h-4 w-4 rounded border-input"
          />
          <span>
            I cannot use the signature pad above. By checking this box, I attest
            that the typed name above is my electronic signature.
          </span>
        </label>
      </CardContent>
      <script src="/static/js/signature-pad.js" defer></script>
    </Card>
  );
}
