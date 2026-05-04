/**
 * /admin/clients/:id/cancel — therapist cancellation form (M9 cleanup #34).
 *
 *   GET  render reason form + 'are you sure' checkbox.
 *   POST call `transitions.cancel`, redirect to detail.
 *
 * Refund handling is orthogonal — admins can issue partial/full refunds
 * via /admin/clients/:id/refund either before or after cancel. State
 * goes to `cancelled` regardless; payments table stays the source of
 * truth for money movement.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { clients, retreats } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import {
  csrfInputHtml,
  ensureCsrfToken,
  verifyCsrfToken,
} from '../../lib/csrf.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';

export const adminCancelRoute = new Hono();

adminCancelRoute.get('/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();

  const [row] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      therapistId: retreats.therapistId,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .where(eq(retreats.id, id));
  if (!row) return c.notFound();
  if (!therapistCanAccess(c.get('user'), row.therapistId)) return c.notFound();

  const error = c.req.query('error');
  const csrfHtml = csrfInputHtml(ensureCsrfToken(c));

  return c.html(
    renderForm({
      retreatId: row.retreatId,
      state: row.state,
      clientName: `${row.clientFirstName} ${row.clientLastName}`,
      error: error ?? null,
      csrfHtml,
    }),
  );
});

adminCancelRoute.post('/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();
  const [owner] = await db
    .select({ therapistId: retreats.therapistId })
    .from(retreats)
    .where(eq(retreats.id, id));
  if (!owner) return c.notFound();
  if (!therapistCanAccess(c.get('user'), owner.therapistId)) return c.notFound();

  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
  if (String(form.get('confirm') ?? '') !== 'yes') {
    return c.redirect(`/admin/clients/${id}/cancel?error=must_confirm`);
  }
  const reasonRaw = String(form.get('reason') ?? '').trim();
  if (reasonRaw.length > 200) {
    return c.redirect(`/admin/clients/${id}/cancel?error=reason_too_long`);
  }
  // PHI guard (M9 fix #30 parallel): reject obvious client-context shapes
  // server-side rather than letting them land in audit_event payloads.
  if (reasonRaw && hasPhiShape(reasonRaw)) {
    return c.redirect(`/admin/clients/${id}/cancel?error=reason_contains_phi`);
  }
  const reason = reasonRaw || undefined;

  try {
    await transitions.cancel({
      retreatId: id,
      actor: { kind: 'system' },
      ...(reason ? { reason } : {}),
    });
  } catch (err) {
    log.warn('admin_cancel_failed', { retreatId: id, error: (err as Error).message });
    const code = encodeURIComponent((err as Error).message).slice(0, 200);
    return c.redirect(`/admin/clients/${id}/cancel?error=${code}`);
  }

  return c.redirect(`/admin/clients/${id}`);
});

interface FormArgs {
  retreatId: string;
  state: string;
  clientName: string;
  error: string | null;
  csrfHtml: string;
}

function renderForm(args: FormArgs): string {
  const stateBlock =
    args.state === 'completed' || args.state === 'cancelled'
      ? `<p style="color:#a00"><strong>State is <code>${escHtml(args.state)}</code></strong> — cancel is only valid before completion.</p>`
      : '';
  const errBlock = args.error
    ? `<p style="color:#a00"><strong>Error:</strong> ${escHtml(decodeURIComponent(args.error))}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Cancel retreat — ITR Client HQ</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-weight: 600; }
    label { display: block; margin-bottom: 0.6rem; }
    label span { display: inline-block; width: 160px; }
    textarea { padding: 0.4rem; font: inherit; width: 420px; height: 4rem; vertical-align: top; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    .meta { color: #666; }
  </style>
</head>
<body>
  <h1>Cancel retreat</h1>
  <p class="meta">Retreat <code>${escHtml(args.retreatId)}</code> · ${escHtml(args.clientName)} · current state <code>${escHtml(args.state)}</code></p>
  <p class="meta">Cancelling moves the retreat to <code>cancelled</code> and emails the support inbox + the assigned therapist. Refunds are handled separately on the Refund form — process those first if you want them recorded against the original deposit/final payment.</p>
  ${stateBlock}
  ${errBlock}
  <form method="post">
    ${args.csrfHtml}
    <label><span>Reason (optional)</span><textarea name="reason" placeholder="Internal note. Stored in the audit_event payload."></textarea></label>
    <label><span>Confirm</span><input type="checkbox" name="confirm" value="yes" required> I understand this cannot be undone.</label>
    <button type="submit">Cancel retreat</button>
  </form>
  <p><a href="/admin/clients/${escAttr(args.retreatId)}">← back to detail</a></p>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escAttr(s: string): string {
  return escHtml(s).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const PHI_EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHI_PHONE_RE = /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const PHI_DOB_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
function hasPhiShape(s: string): boolean {
  return PHI_EMAIL_RE.test(s) || PHI_PHONE_RE.test(s) || PHI_DOB_RE.test(s);
}
