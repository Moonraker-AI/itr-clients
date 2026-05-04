/**
 * /admin/clients/:id/confirm-dates — therapist date-confirmation form (M4).
 *
 *   GET   render minimal HTML form with start + end date inputs.
 *   POST  call `transitions.confirmDates` and redirect back to detail.
 *
 * The form is hidden on the detail page when state != awaiting_deposit
 * (or when the deposit_paid audit_event is missing); the route itself
 * still defends against state mismatch via the transition's own checks.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { auditEvents, clients, retreats } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';

export const adminConfirmDatesRoute = new Hono();

adminConfirmDatesRoute.get('/:id/confirm-dates', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();

  const [row] = await db
    .select({
      retreatId: retreats.id,
      state: retreats.state,
      therapistId: retreats.therapistId,
      plannedFullDays: retreats.plannedFullDays,
      plannedHalfDays: retreats.plannedHalfDays,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
    })
    .from(retreats)
    .innerJoin(clients, eq(retreats.clientId, clients.id))
    .where(eq(retreats.id, id));
  if (!row) return c.notFound();
  if (!therapistCanAccess(c.get('user'), row.therapistId)) return c.notFound();

  const [paid] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.retreatId, id),
        eq(auditEvents.eventType, 'deposit_paid'),
      ),
    )
    .limit(1);

  const error = c.req.query('error');

  return c.html(renderForm({
    retreatId: row.retreatId,
    state: row.state,
    plannedFullDays: row.plannedFullDays,
    plannedHalfDays: row.plannedHalfDays,
    clientName: `${row.clientFirstName} ${row.clientLastName}`,
    depositPaid: Boolean(paid),
    error: error ?? null,
  }));
});

adminConfirmDatesRoute.post('/:id/confirm-dates', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();
  const [owner] = await db
    .select({ therapistId: retreats.therapistId })
    .from(retreats)
    .where(eq(retreats.id, id));
  if (!owner) return c.notFound();
  if (!therapistCanAccess(c.get('user'), owner.therapistId)) return c.notFound();

  const form = await c.req.formData();
  const startDate = String(form.get('start_date') ?? '').trim();
  const endDate = String(form.get('end_date') ?? '').trim();

  if (!startDate || !endDate) {
    return c.redirect(`/admin/clients/${id}/confirm-dates?error=missing_dates`);
  }

  try {
    await transitions.confirmDates({
      retreatId: id,
      actor: { kind: 'system' },
      startDate,
      endDate,
    });
  } catch (err) {
    log.warn('admin_confirm_dates_failed', {
      retreatId: id,
      error: (err as Error).message,
    });
    const code = encodeURIComponent((err as Error).message).slice(0, 200);
    return c.redirect(`/admin/clients/${id}/confirm-dates?error=${code}`);
  }

  return c.redirect(`/admin/clients/${id}`);
});

interface FormArgs {
  retreatId: string;
  state: string;
  plannedFullDays: number;
  plannedHalfDays: number;
  clientName: string;
  depositPaid: boolean;
  error: string | null;
}

function renderForm(args: FormArgs): string {
  const planned = args.plannedFullDays + args.plannedHalfDays / 2;
  const banner = args.depositPaid
    ? ''
    : '<p style="color:#a00"><strong>Deposit not yet paid.</strong> Submitting will fail. Confirm payment first.</p>';
  const stateBlock =
    args.state !== 'awaiting_deposit'
      ? `<p style="color:#a00"><strong>State is <code>${escHtml(args.state)}</code></strong> — only <code>awaiting_deposit</code> can confirm dates.</p>`
      : '';
  const errBlock = args.error
    ? `<p style="color:#a00"><strong>Error:</strong> ${escHtml(decodeURIComponent(args.error))}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Confirm dates — ITR Client HQ</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-weight: 600; }
    label { display: block; margin-bottom: 0.6rem; }
    label span { display: inline-block; width: 160px; }
    input[type=date] { padding: 0.4rem; font: inherit; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    .meta { color: #666; }
  </style>
</head>
<body>
  <h1>Confirm retreat dates</h1>
  <p class="meta">Retreat <code>${escHtml(args.retreatId)}</code> · ${escHtml(args.clientName)}</p>
  <p class="meta">Planned: ${args.plannedFullDays} full + ${args.plannedHalfDays} half = <strong>${planned}</strong> day-equivalents (span tolerance ±1)</p>
  ${stateBlock}
  ${banner}
  ${errBlock}
  <form method="post">
    <label><span>Start date</span><input type="date" name="start_date" required></label>
    <label><span>End date</span><input type="date" name="end_date" required></label>
    <button type="submit">Confirm + send calendar invite</button>
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
