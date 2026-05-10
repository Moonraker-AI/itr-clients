/**
 * /admin/bulk - bulk actions over a checkbox-selected set of retreats
 * (P3 #3, v0.16.0).
 *
 * Two actions for now:
 *   - cancel        → transitions.cancel for each id
 *   - resend-consent → transitions.resendConsentPackage for each id
 *
 * Per-id failures are caught + counted, not propagated, so a partial
 * failure (e.g. one retreat already cancelled) doesn't prevent the rest
 * from succeeding. A summary lands in the redirect query string and is
 * surfaced as a banner on the dashboard.
 *
 * Therapist scoping: each id is checked against `therapistCanAccess`
 * and skipped if the current user can't access it. We never error or
 * leak existence of inaccessible ids - a non-admin therapist trying to
 * bulk-cancel another therapist's retreats just gets `0 ok, N skipped`.
 *
 * Cap: 25 ids per request. Beyond that the per-request budget on Cloud
 * Run starts to bite (each cancel sends 2 emails); ops should split.
 */

import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { retreats } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { verifyCsrfToken } from '../../lib/csrf.js';
import { log } from '../../lib/phi-redactor.js';
import { transitions } from '../../lib/state-machine.js';

export const adminBulkRoute = new Hono();

const MAX_IDS = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = ['cancel', 'resend-consent'] as const;
type BulkAction = (typeof ACTIONS)[number];

interface BulkSummary {
  action: BulkAction;
  ok: number;
  skipped: number;
  failed: number;
  errors: { retreatId: string; error: string }[];
}

adminBulkRoute.post('/', async (c) => {
  const form = await c.req.formData();
  if (!verifyCsrfToken(c, String(form.get('_csrf') ?? ''))) {
    return c.json({ error: 'csrf_mismatch' }, 403);
  }

  const actionRaw = String(form.get('action') ?? '');
  if (!(ACTIONS as readonly string[]).includes(actionRaw)) {
    return c.redirect('/admin?bulk_error=invalid_action');
  }
  const action = actionRaw as BulkAction;

  const idsRaw = form.getAll('ids').map(String);
  const ids = Array.from(
    new Set(idsRaw.filter((id) => UUID_RE.test(id))),
  ).slice(0, MAX_IDS);

  if (ids.length === 0) {
    return c.redirect('/admin?bulk_error=no_ids_selected');
  }

  const user = c.get('user');
  const { db } = await getDb();

  // Pre-fetch ownership in one query so we don't hit the DB once per id.
  const owners = await db
    .select({ id: retreats.id, therapistId: retreats.therapistId })
    .from(retreats)
    .where(inArray(retreats.id, ids));
  const ownerById = new Map<string, string>();
  for (const o of owners) ownerById.set(o.id, o.therapistId);

  const summary: BulkSummary = {
    action,
    ok: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const id of ids) {
    const therapistId = ownerById.get(id);
    if (!therapistId || !therapistCanAccess(user, therapistId)) {
      summary.skipped += 1;
      continue;
    }
    try {
      if (action === 'cancel') {
        await transitions.cancel({
          retreatId: id,
          actor: { kind: 'system' },
        });
      } else {
        await transitions.resendConsentPackage({
          retreatId: id,
          actor: { kind: 'system' },
        });
      }
      summary.ok += 1;
    } catch (err) {
      const message = (err as Error).message;
      summary.failed += 1;
      summary.errors.push({ retreatId: id, error: message });
      log.warn('admin_bulk_item_failed', { action, retreatId: id, error: message });
    }
  }

  log.info('admin_bulk_run', {
    action,
    ok: summary.ok,
    skipped: summary.skipped,
    failed: summary.failed,
    requested: ids.length,
  });

  // Encode the summary into the redirect so the dashboard banner can
  // render it without a session round-trip. Stays under 2KB even with
  // 25 errors at 100 chars each.
  const encoded = encodeURIComponent(JSON.stringify(summary));
  return c.redirect(`/admin?bulk_result=${encoded}`);
});
