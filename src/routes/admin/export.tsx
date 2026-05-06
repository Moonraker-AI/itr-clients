/**
 * /admin/clients/:id/export.json — HIPAA right-of-access JSON dump.
 *
 * Returns the full server-side data we hold about a single retreat:
 * client + retreat + payments + signed consents (with GCS storage paths)
 * + audit_events + email_log. The client receives this on request as a
 * machine-readable export.
 *
 * PDFs are NOT bundled — they live in GCS and are referenced by storage
 * path. Operator can fetch them via:
 *   gsutil cp gs://<bucket>/<path> ./
 *
 * A bundled-zip variant is a follow-up (needs `archiver` dep). For V1
 * the JSON + storage-path references satisfy right-of-access spirit.
 *
 * Auth: gated behind requireAuth + therapistCanAccess. Every export call
 * is recorded in audit_events as `admin_export_pii` so we have a paper
 * trail of who exported what + when.
 */

import { Hono } from 'hono';
import { asc, desc, eq } from 'drizzle-orm';

import { getDb } from '../../db/client.js';
import {
  auditEvents,
  clients,
  consentSignatures,
  consentTemplates,
  emailLog,
  payments,
  retreatRequiredConsents,
  retreats,
  stripeCustomers,
  therapists,
} from '../../db/schema.js';
import { therapistCanAccess } from '../../lib/auth.js';
import { log } from '../../lib/phi-redactor.js';

export const adminExportRoute = new Hono();

adminExportRoute.get('/:id/export.json', async (c) => {
  const id = c.req.param('id');
  const { db } = await getDb();
  const user = c.get('user');

  const [retreat] = await db
    .select()
    .from(retreats)
    .where(eq(retreats.id, id));
  if (!retreat) return c.notFound();
  if (!therapistCanAccess(user, retreat.therapistId)) return c.notFound();

  const [client] = await db.select().from(clients).where(eq(clients.id, retreat.clientId));
  const [therapist] = await db.select().from(therapists).where(eq(therapists.id, retreat.therapistId));
  const [stripeCustomer] = await db
    .select()
    .from(stripeCustomers)
    .where(eq(stripeCustomers.clientId, retreat.clientId));

  const paymentRows = await db
    .select()
    .from(payments)
    .where(eq(payments.retreatId, id))
    .orderBy(asc(payments.createdAt));

  const requiredConsents = await db
    .select({
      templateId: retreatRequiredConsents.templateId,
      templateName: consentTemplates.name,
      templateVersion: consentTemplates.version,
      requiresSignature: consentTemplates.requiresSignature,
    })
    .from(retreatRequiredConsents)
    .innerJoin(consentTemplates, eq(retreatRequiredConsents.templateId, consentTemplates.id))
    .where(eq(retreatRequiredConsents.retreatId, id));

  const signatures = await db
    .select()
    .from(consentSignatures)
    .where(eq(consentSignatures.retreatId, id))
    .orderBy(asc(consentSignatures.signedAt));

  // Audit log — every transition + admin action is in here.
  const audits = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.retreatId, id))
    .orderBy(desc(auditEvents.createdAt));

  const emails = await db
    .select()
    .from(emailLog)
    .where(eq(emailLog.retreatId, id))
    .orderBy(desc(emailLog.sentAt));

  // Record the export itself in audit_events so there's a paper trail.
  // Don't include the export contents in the audit payload — only who +
  // when. The state-machine is unchanged (no transition).
  await db
    .insert(auditEvents)
    .values({
      retreatId: id,
      actorType: user?.role === 'therapist' ? 'therapist' : 'system',
      actorId: user?.role === 'therapist' ? user.therapistId : null,
      eventType: 'admin_export_pii',
      payload: {
        exported_by_email: user?.email ?? null,
      },
    })
    .catch((err: unknown) => {
      log.warn('admin_export_audit_write_failed', {
        retreatId: id,
        error: (err as Error).message,
      });
    });

  log.info('admin_export_pii', {
    retreatId: id,
    exportedByEmail: user?.email ?? null,
  });

  const snapshot = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    exported_by: user?.email ?? null,
    retreat,
    client,
    therapist: therapist
      ? {
          id: therapist.id,
          fullName: therapist.fullName,
          email: therapist.email,
          slug: therapist.slug,
        }
      : null,
    stripe_customer: stripeCustomer
      ? {
          stripeCustomerId: stripeCustomer.stripeCustomerId,
          createdAt: stripeCustomer.createdAt,
        }
      : null,
    payments: paymentRows,
    required_consents: requiredConsents,
    signatures: signatures.map((s) => ({
      ...s,
      // PDFs live in GCS; expose the storage path so the operator can
      // fetch them via gsutil. Don't sign URLs here — the JSON dump is
      // long-lived and signed URLs expire.
      pdf_gcs_path: s.pdfStoragePath ?? null,
    })),
    audit_events: audits,
    email_log: emails,
  };

  c.header(
    'Content-Disposition',
    `attachment; filename="retreat-${id}-${new Date().toISOString().slice(0, 10)}.json"`,
  );
  return c.json(snapshot);
});
