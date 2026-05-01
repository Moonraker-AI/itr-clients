/**
 * Cloud Storage uploads — signed consent PDFs and signature evidence.
 *
 * Both prod buckets are CMEK-bound to `storage-key` (GCP_BOOTSTRAP §5);
 * uploads inherit that encryption automatically. Service account credentials
 * come from the Cloud Run runtime SA via Application Default Credentials —
 * no JSON key file needed.
 *
 * Bucket selection:
 *   - GCS_CONSENTS_BUCKET env var if set
 *   - else `itr-consents-{prod|dev}` derived from CLOUD_SQL_INSTANCE prefix
 */

import { Storage, type Bucket } from '@google-cloud/storage';

let storage: Storage | null = null;
let bucketCache: Bucket | null = null;

function getBucket(): Bucket {
  if (bucketCache) return bucketCache;
  storage ??= new Storage();

  const explicit = process.env.GCS_CONSENTS_BUCKET;
  if (explicit) {
    bucketCache = storage.bucket(explicit);
    return bucketCache;
  }

  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) {
    throw new Error(
      'GCS_CONSENTS_BUCKET unset and CLOUD_SQL_INSTANCE missing — cannot pick consents bucket',
    );
  }
  // CLOUD_SQL_INSTANCE format: <project>:<region>:<instance>
  const project = instance.split(':')[0] ?? '';
  const env = project.includes('prod') ? 'prod' : 'dev';
  bucketCache = storage.bucket(`itr-consents-${env}`);
  return bucketCache;
}

export interface UploadResult {
  /** gs://bucket/object form. */
  storagePath: string;
  bucket: string;
  object: string;
}

export async function uploadConsentPdf(args: {
  retreatId: string;
  templateName: string;
  templateVersion: number;
  signatureId: string;
  pdf: Buffer;
}): Promise<UploadResult> {
  const bucket = getBucket();
  const objectName = consentPdfObjectName(args);
  const file = bucket.file(objectName);
  await file.save(args.pdf, {
    contentType: 'application/pdf',
    resumable: false,
    metadata: {
      cacheControl: 'private, max-age=0, no-store',
      metadata: {
        retreat_id: args.retreatId,
        template_name: args.templateName,
        template_version: String(args.templateVersion),
        signature_id: args.signatureId,
      },
    },
  });
  return {
    storagePath: `gs://${bucket.name}/${objectName}`,
    bucket: bucket.name,
    object: objectName,
  };
}

export async function uploadSignatureImage(args: {
  retreatId: string;
  signatureId: string;
  /** PNG bytes decoded from the data URL. */
  png: Buffer;
}): Promise<UploadResult> {
  const bucket = getBucket();
  const objectName = signatureObjectName(args);
  const file = bucket.file(objectName);
  await file.save(args.png, {
    contentType: 'image/png',
    resumable: false,
    metadata: {
      cacheControl: 'private, max-age=0, no-store',
      metadata: {
        retreat_id: args.retreatId,
        signature_id: args.signatureId,
      },
    },
  });
  return {
    storagePath: `gs://${bucket.name}/${objectName}`,
    bucket: bucket.name,
    object: objectName,
  };
}

export function consentPdfObjectName(args: {
  retreatId: string;
  templateName: string;
  templateVersion: number;
  signatureId: string;
}): string {
  return `retreats/${args.retreatId}/consents/${args.templateName}-v${args.templateVersion}-${args.signatureId}.pdf`;
}

export function signatureObjectName(args: {
  retreatId: string;
  signatureId: string;
}): string {
  return `retreats/${args.retreatId}/signatures/${args.signatureId}.png`;
}

/**
 * Decodes a PNG data URL produced by an HTML5 canvas signature pad.
 * Throws if the prefix is missing or the payload is empty — never feed
 * unvalidated input straight into a Buffer.
 */
export function decodeSignatureDataUrl(dataUrl: string): Buffer {
  const m = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('signature data URL malformed');
  const payload = m[1]!;
  const buf = Buffer.from(payload, 'base64');
  if (buf.length === 0) throw new Error('signature data URL empty');
  return buf;
}
