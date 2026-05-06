/**
 * /admin/clients/:id/consents/:signatureId/pdf
 *
 * Streams the signed PDF directly through the app server. Avoids the
 * IAM `iam.serviceAccounts.signBlob` permission a v4 signed URL would
 * need; the runtime SA already has read access to the bucket via its
 * normal Storage permissions, and we proxy the bytes.
 *
 * Auth-gated by the admin requireAuth middleware + therapistCanAccess
 * so therapists only see their own clients' PDFs. Every access writes
 * `admin_consent_pdf_accessed` to audit_events.
 *
 * Bandwidth: consent PDFs are ~100–500 KB each, low volume (one per
 * signed consent per access). Acceptable to proxy through Cloud Run.
 */

import { Hono } from 'hono';
import { Storage } from '@google-cloud/storage';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import { auditEvents, consentSignatures, retreats } from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { log } from '../../lib/phi-redactor.js';

export const adminConsentPdfRoute = new Hono();

let storage: Storage | null = null;

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

  const m = sig.pdfStoragePath.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!m) {
    log.error('admin_consent_pdf_bad_storage_path', {
      retreatId: id,
      signatureId,
      storagePath: sig.pdfStoragePath,
    });
    return c.json({ error: 'invalid_storage_path' }, 500);
  }
  const [, bucketName, objectName] = m;

  let buf: Buffer;
  try {
    storage ??= new Storage();
    const [downloaded] = await storage
      .bucket(bucketName!)
      .file(objectName!)
      .download();
    buf = downloaded;
  } catch (err) {
    log.error('admin_consent_pdf_download_failed', {
      retreatId: id,
      signatureId,
      error: (err as Error).message,
    });
    return c.json({ error: 'pdf_download_failed' }, 500);
  }

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

  c.header('Content-Type', 'application/pdf');
  c.header(
    'Content-Disposition',
    `inline; filename="consent-${signatureId.slice(0, 8)}.pdf"`,
  );
  c.header('Cache-Control', 'private, max-age=0, no-store');
  return c.body(buf as unknown as ArrayBuffer);
});
