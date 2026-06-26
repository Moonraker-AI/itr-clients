/**
 * /admin/clients/:id/reconcile-deposit - manual deposit reconcile (safety net).
 *
 * Unsticks a retreat that is sitting in `awaiting_deposit` after the client
 * paid, when the Stripe webhook was missed/delayed (or the deposit was ACH
 * and cleared after the client left). Asks Stripe directly whether a paid
 * deposit session exists for this client + retreat and, if so, records it
 * via the same idempotent markDepositPaid the webhook would have run.
 *
 * POST-only; the button lives on the client detail page. Mirrors the cron
 * and success-page reconcile paths.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { retreats } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { verifyCsrfToken } from '../../lib/csrf.js';
import { log } from '../../lib/phi-redactor.js';
import { reconcileDepositForRetreat } from '../../lib/state-machine.js';

export const adminReconcileRoute = new Hono();

adminReconcileRoute.post('/:id/reconcile-deposit', async (c) => {
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

  try {
    const { outcome } = await reconcileDepositForRetreat(id, { kind: 'system' });
    log.info('admin_reconcile_deposit', { retreatId: id, outcome });
    return c.redirect(`/admin/clients/${id}?reconcile=${outcome}`);
  } catch (err) {
    log.warn('admin_reconcile_deposit_failed', {
      retreatId: id,
      error: (err as Error).message,
    });
    return c.redirect(`/admin/clients/${id}?reconcile=error`);
  }
});
