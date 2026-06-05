import { createHash } from 'node:crypto';

export const INQUIRY_STATUSES = [
  'new',
  'contacted',
  'follow_up_needed',
  'consult_scheduled',
  'converted',
  'archived',
  'spam_duplicate',
] as const;

export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export const INQUIRY_STATUS_LABELS: Record<InquiryStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  follow_up_needed: 'Follow-up needed',
  consult_scheduled: 'Consult scheduled',
  converted: 'Converted',
  archived: 'Archived',
  spam_duplicate: 'Spam or duplicate',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,80}[a-z0-9]$/;

export interface ValidContactInquiry {
  therapistSlug: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  timezone: string;
  consultationWindows: string[];
  message: string | null;
  heardFrom: string | null;
  consentPhone: boolean;
  consentText: boolean;
  consentEmail: boolean;
  policyServiceLevel: boolean;
  policyFinancial: boolean;
  sourcePage: string | null;
  sourceKey: string | null;
  contactHash: string;
  messageHash: string | null;
}

export type InquiryValidationResult =
  | { ok: true; data: ValidContactInquiry }
  | { ok: false; error: string };

function clean(value: unknown, max: number): string {
  if (value == null) return '';
  const s = String(value).trim();
  if (!s) return '';
  return s.slice(0, max);
}

function boolValue(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

function splitName(value: string): { firstName: string; lastName: string } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0] ?? '', lastName: '' };
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
  };
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function hashValue(value: string): string {
  const salt = process.env.CONTACT_INQUIRY_HASH_SALT ?? 'itr-contact-inquiry-v1';
  return createHash('sha256').update(salt).update('\0').update(value).digest('hex');
}

export function hashIp(ip: string): string | null {
  const cleaned = clean(ip, 128);
  return cleaned ? hashValue(`ip:${cleaned}`) : null;
}

export function normalizeMessage(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

export function validateContactInquiryPayload(raw: unknown): InquiryValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'invalid_payload' };
  }
  const body = raw as Record<string, unknown>;

  const therapistSlug = clean(
    body.therapistSlug ?? body.therapist_slug ?? body.clinicianId ?? body.clinician_id,
    96,
  ).toLowerCase();
  if (!SLUG_RE.test(therapistSlug)) {
    return { ok: false, error: 'invalid_therapist' };
  }

  const nameParts = splitName(clean(body.name, 180));
  const firstName = clean(body.firstName ?? body.first_name, 80) || nameParts.firstName;
  const lastName = clean(body.lastName ?? body.last_name, 80) || nameParts.lastName;
  const email = clean(body.email, 254).toLowerCase();
  const phone = clean(body.phone, 40);
  const location = clean(body.location, 160);
  const timezone = clean(body.timezone, 80);
  const message = clean(body.message, 3000) || null;
  const heardFrom = clean(body.heardFrom ?? body.heard_from, 120) || null;
  const sourcePage = clean(body.sourcePage ?? body.source_page ?? body.page, 800) || null;
  const sourceKey = clean(body.sourceKey ?? body.source_key ?? body.source, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '') || null;

  const rawWindows = body.consultationTime ?? body.consultation_time ?? body.consultationWindows;
  const consultationWindows = (Array.isArray(rawWindows) ? rawWindows : [rawWindows])
    .map((v) => clean(v, 40))
    .filter(Boolean)
    .slice(0, 6);

  const consentPhone = boolValue(body.consentPhone ?? body.consent_phone);
  const consentText = boolValue(body.consentText ?? body.consent_text);
  const consentEmail = boolValue(body.consentEmail ?? body.consent_email);
  const policyServiceLevel = boolValue(
    body.policyServiceLevel ?? body.policy_service_level,
  );
  const policyFinancial = boolValue(body.policyFinancial ?? body.policy_financial);

  if (!firstName || !lastName || !email || !phone || !location || !timezone) {
    return { ok: false, error: 'missing_required_fields' };
  }
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone.length < 10) return { ok: false, error: 'invalid_phone' };
  if (consultationWindows.length === 0) {
    return { ok: false, error: 'missing_consultation_window' };
  }
  if (!consentPhone && !consentText && !consentEmail) {
    return { ok: false, error: 'missing_contact_consent' };
  }
  if (!policyServiceLevel || !policyFinancial) {
    return { ok: false, error: 'missing_policy_acknowledgment' };
  }

  const contactHash = hashValue(`contact:${email}|${normalizedPhone}`);
  const normalizedMessage = message ? normalizeMessage(message) : '';
  const messageHash = normalizedMessage
    ? hashValue(`message:${contactHash}|${normalizedMessage}`)
    : null;

  return {
    ok: true,
    data: {
      therapistSlug,
      firstName,
      lastName,
      email,
      phone,
      location,
      timezone,
      consultationWindows,
      message,
      heardFrom,
      consentPhone,
      consentText,
      consentEmail,
      policyServiceLevel,
      policyFinancial,
      sourcePage,
      sourceKey,
      contactHash,
      messageHash,
    },
  };
}
