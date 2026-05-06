/**
 * /admin/clients/:id/consents/:signatureId/pdf
 *
 * Returns a 302 to a short-lived GCS v4 signed URL for the signed PDF.
 * Auth-gated by the admin requireAuth middleware + therapistCanAccess
 * to ensure therapists can only fetch their own clients' PDFs.
 *
 * The signed URL is single-use-ish (5 min TTL) — don't log it. Audit
 * the access via audit_events so we have a record of who pulled what.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { auditEvents, consentSignatures, retreats } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { log } from '../../lib/phi-redactor.js';
import { getSignedDownloadUrl } from '../../lib/storage.js';

export const adminConsentPdfRoute = new Hono();

adminConsentPdfRoute.get('/:id/consents/:signatureId/pdf', async (c) => {
  const id = c.req.param('id');
  const signatureId = c.req.param('signatureId');
  const { db } = await getDb();
  const user = c.get('user');

  const [retreat] = await db
    .select({ therapistId: retreats.therapistId })
    .from(retreats)
    .where(eq(retreats.id, id));
  if (!retreat) return c.notFound();
  if (!therapistCanAccess(user, retreat.therapistId)) return c.notFound();

  const [sig] = await db
    .select({
      id: consentSignatures.id,
      pdfStoragePath: consentSignatures.pdfStoragePath,
    })
    .from(consentSignatures)
    .where(
      and(eq(consentSignatures.id, signatureId), eq(consentSignatures.retreatId, id)),
    );
  if (!sig) return c.notFound();
  if (!sig.pdfStoragePath) {
    return c.json({ error: 'pdf_not_yet_uploaded' }, 404);
  }

  let url: string;
  try {
    url = await getSignedDownloadUrl({ storagePath: sig.pdfStoragePath });
  } catch (err) {
    log.error('admin_consent_pdf_signed_url_failed', {
      retreatId: id,
      signatureId,
      error: (err as Error).message,
    });
    return c.json({ error: 'signed_url_generation_failed' }, 500);
  }

  // Audit the access. Don't include the URL itself (it's a fresh credential).
  await db
    .insert(auditEvents)
    .values({
      retreatId: id,
      actorType: user?.role === 'therapist' ? 'therapist' : 'system',
      actorId: user?.role === 'therapist' ? user.therapistId : null,
      eventType: 'admin_consent_pdf_accessed',
      payload: {
        signature_id: signatureId,
        accessed_by_email: user?.email ?? null,
      },
    })
    .catch((auditErr: unknown) => {
      log.warn('admin_consent_pdf_audit_failed', {
        retreatId: id,
        signatureId,
        error: (auditErr as Error).message,
      });
    });

  return c.redirect(url);
});
