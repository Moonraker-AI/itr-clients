/**
 * /admin/clients/:id/confirm-dates - therapist date-confirmation form (M4).
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { auditEvents, clients, retreats } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { ensureCsrfToken, verifyCsrfToken } from '../../lib/csrf.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';
import {
  AdminShell,
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CsrfInput,
  Field,
  Input,
  Layout,
  LinkButton,
  PageHeader,
} from '../../lib/ui/index.js';

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
    .where(and(eq(auditEvents.retreatId, id), eq(auditEvents.eventType, 'deposit_paid')))
    .limit(1);

  const error = c.req.query('error');
  const csrfToken = ensureCsrfToken(c);
  const user = c.get('user');
  const planned = row.plannedFullDays + row.plannedHalfDays / 2;
  const clientName = `${row.clientFirstName} ${row.clientLastName}`;

  return c.html(
    <Layout title="Confirm dates - ITR Clients">
      <AdminShell user={user} current="dashboard">
        <PageHeader title="Confirm retreat dates" description={`${clientName} · ${id.slice(0, 8)}`}>
          <LinkButton href={`/admin/clients/${id}`} variant="ghost" size="sm">
            ← back
          </LinkButton>
        </PageHeader>

        <div class="max-w-2xl space-y-4">
          {row.state !== 'awaiting_deposit' ? (
            <Alert variant="destructive">
              <AlertTitle>Wrong state</AlertTitle>
              <AlertDescription>
                State is <code class="font-mono">{row.state}</code> - only{' '}
                <code class="font-mono">awaiting_deposit</code> can confirm dates.
              </AlertDescription>
            </Alert>
          ) : null}
          {!paid ? (
            <Alert variant="destructive">
              <AlertTitle>Deposit not yet paid</AlertTitle>
              <AlertDescription>Submitting will fail. Confirm payment first.</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{decodeURIComponent(error)}</AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Dates</CardTitle>
              <CardDescription>
                Planned: {row.plannedFullDays} full + {row.plannedHalfDays} half ={' '}
                <strong>{planned}</strong> day-equivalents (span tolerance ±1)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form method="post" class="space-y-4">
                <CsrfInput token={csrfToken} />
                <Field label="Start date" for="start_date">
                  <Input id="start_date" name="start_date" type="date" required />
                </Field>
                <Field label="End date" for="end_date">
                  <Input id="end_date" name="end_date" type="date" required />
                </Field>
                <Button type="submit">Confirm + send calendar invite</Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </AdminShell>
    </Layout>,
  );
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
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }
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
