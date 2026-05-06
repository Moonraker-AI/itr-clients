/**
 * /admin/clients/:id/cancel - therapist cancellation form (M9 cleanup #34).
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { clients, retreats } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { ensureCsrfToken, verifyCsrfToken } from '../../lib/csrf.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';
import {
  AdminShell,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CsrfInput,
  Field,
  Layout,
  LinkButton,
  PageHeader,
  Textarea,
} from '../../lib/ui/index.js';

export const adminCancelRoute = new Hono();

const PHI_EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHI_PHONE_RE = /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const PHI_DOB_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
function hasPhiShape(s: string): boolean {
  return PHI_EMAIL_RE.test(s) || PHI_PHONE_RE.test(s) || PHI_DOB_RE.test(s);
}

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
  const csrfToken = ensureCsrfToken(c);
  const user = c.get('user');
  const clientName = `${row.clientFirstName} ${row.clientLastName}`;
  const blockedState = row.state === 'completed' || row.state === 'cancelled';

  return c.html(
    <Layout title="Cancel retreat - ITR Clients">
      <AdminShell user={user} current="dashboard">
        <PageHeader title="Cancel retreat" description={`${clientName} · ${id.slice(0, 8)}`}>
          <Badge variant="secondary">{row.state}</Badge>
          <LinkButton href={`/admin/clients/${id}`} variant="ghost" size="sm">
            ← back
          </LinkButton>
        </PageHeader>

        <div class="max-w-2xl space-y-4">
          {blockedState ? (
            <Alert variant="destructive">
              <AlertTitle>State blocks cancel</AlertTitle>
              <AlertDescription>
                State is <code class="font-mono">{row.state}</code> - cancel is only valid before
                completion.
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{decodeURIComponent(error)}</AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Cancel</CardTitle>
              <CardDescription>
                Moves retreat to <code class="font-mono">cancelled</code> and emails support + the
                assigned therapist. Refunds handled separately on the Refund form - process those first
                if you want them recorded.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form method="post" class="space-y-4">
                <CsrfInput token={csrfToken} />
                <Field
                  label="Reason (optional)"
                  for="reason"
                  hint="Internal note. Stored in the audit_event payload."
                >
                  <Textarea id="reason" name="reason" rows={3} />
                </Field>
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="confirm"
                    value="yes"
                    required
                    class="h-4 w-4 rounded border-input"
                  />
                  I understand this cannot be undone.
                </label>
                <Button type="submit" variant="destructive">
                  Cancel retreat
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </AdminShell>
    </Layout>,
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
