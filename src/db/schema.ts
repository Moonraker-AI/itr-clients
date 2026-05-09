/**
 * Drizzle schema.
 *
 * M1: therapists, locations, pricing_config.
 * M2: clients, retreats, consent_templates, consent_signatures, audit_events,
 *     email_log, notification_recipients. Adds affirm_uplift_pct and
 *     cancellation_admin_fee_cents to pricing_config.
 * M3: stripe_customers, payments. Adds payment_kind, payment_status enums.
 *
 * Conventions:
 *   - UUID primary keys (defaultRandom).
 *   - All money in cents (integer).
 *   - All timestamps tz-aware (timestamp with time zone, default now()).
 *   - PHI-bearing columns are flagged in comments and live exclusively in
 *     itr-clients-prod-phi at runtime. Dev gets synthetic data only.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const therapistRole = pgEnum('therapist_role', ['admin', 'therapist']);

export const retreatState = pgEnum('retreat_state', [
  'draft',
  'awaiting_consents',
  'awaiting_deposit',
  'scheduled',
  'in_progress',
  'awaiting_final_charge',
  'completed',
  'final_charge_failed',
  'cancelled',
]);

export const paymentMethod = pgEnum('payment_method', ['ach', 'card']);

export const pricingBasis = pgEnum('pricing_basis', [
  'standard',
  'sliding_scale',
  'comp',
]);

export const actorType = pgEnum('actor_type', [
  'therapist',
  'client',
  'system',
  'stripe',
]);

export const emailStatus = pgEnum('email_status', [
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
]);

export const retreatProgram = pgEnum('retreat_program', ['itr', 'kair']);

export const paymentKind = pgEnum('payment_kind', ['deposit', 'final', 'refund']);

export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'succeeded',
  'failed',
  'refunded',
]);

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  address: text('address'),
  city: text('city').notNull(),
  state: text('state').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const therapists = pgTable('therapists', {
  id: uuid('id').primaryKey().defaultRandom(),
  fullName: text('full_name').notNull(),
  slug: text('slug').notNull().unique(),
  email: text('email').notNull().unique(),
  role: therapistRole('role').notNull().default('therapist'),
  primaryLocationId: uuid('primary_location_id').references(() => locations.id),
  defaultFullDayCents: integer('default_full_day_cents').notNull(),
  defaultHalfDayCents: integer('default_half_day_cents'),
  // KAIR program (v0.23.0). Only KAIR-eligible therapists may be assigned to
  // a retreat with program='kair'. The kair_*_day_cents are required when
  // kair_eligible=true (server-side validation; not enforced at the DB
  // because legacy rows pre-migration have neither column populated).
  kairEligible: boolean('kair_eligible').notNull().default(false),
  kairFullDayCents: integer('kair_full_day_cents'),
  kairHalfDayCents: integer('kair_half_day_cents'),
  // Stripe Connect account for therapist-direct payouts (Phase C, v0.25+).
  // Stored now so we can backfill from operational records without a
  // second migration. NULL = legacy direct-charge pipeline (e.g. Ross).
  stripeConnectAccountId: text('stripe_connect_account_id'),
  // Therapist's share of charged retreat revenue. 0..100. Default 80%
  // matches the spreadsheet baseline; Bambi is the only exception today
  // at 100%. Used by the v0.25+ payout pipeline; ignored before then.
  therapistPayoutPct: numeric('therapist_payout_pct', { precision: 5, scale: 2 })
    .notNull()
    .default('80'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Single-row config table. The `id` is a constant 'singleton' string PK so the
 * unique row can be upserted without juggling UUIDs.
 */
export const pricingConfig = pgTable('pricing_config', {
  id: text('id').primaryKey().default('singleton'),
  achDiscountPct: numeric('ach_discount_pct', { precision: 5, scale: 4 })
    .notNull()
    .default(sql`0.0300`),
  affirmUpliftPct: numeric('affirm_uplift_pct', { precision: 5, scale: 4 })
    .notNull()
    .default(sql`0.1000`),
  cancellationAdminFeeCents: integer('cancellation_admin_fee_cents')
    .notNull()
    .default(10_000),
  defaultDepositDays: integer('default_deposit_days').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => therapists.id),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Clients. PHI-heavy table — every PHI-flagged column stays out of logs
 * (phi-redactor.ts) and out of Stripe (DESIGN.md §16).
 */
export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  // PHI: name + contact
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  // PHI, optional. Required only when consent flow demands it.
  dob: date('dob'),
  // PHI: emergency contact
  emergencyContactName: text('emergency_contact_name'),
  emergencyContactPhone: text('emergency_contact_phone'),
  // Used for therapist-licensure jurisdiction checks (DESIGN §14 open Q).
  stateOfResidence: text('state_of_residence'),
  // PHI, therapist-only. Free-text — redactor will truncate >120 chars in logs.
  notes: text('notes'),
  createdByTherapistId: uuid('created_by_therapist_id')
    .notNull()
    .references(() => therapists.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Retreats — the spine of the system. State transitions go through
 * src/lib/state-machine.ts; nothing else mutates `state`. Pricing is
 * snapshotted at creation (DESIGN §4) — never join to live pricing_config
 * when computing a retreat's totals.
 *
 * `updated_at` semantics (audit #41): bumped only on retreat-row mutations
 * (state transitions, day-count submissions, schedule edits). It is NOT
 * the freshest timestamp for the retreat as a whole — `payments.updated_at`
 * for the same retreat advances independently on every Stripe attempt
 * (deposit/final/refund retries). Treat them as two parallel timelines:
 * `retreats.updated_at` for state mutations, `payments.updated_at` for
 * money mutations. Reports needing "last activity" should MAX over both.
 */
export const retreats = pgTable(
  'retreats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    therapistId: uuid('therapist_id')
      .notNull()
      .references(() => therapists.id),
    locationId: uuid('location_id').references(() => locations.id),
    state: retreatState('state').notNull().default('draft'),
    // Retreat program (v0.23.0). 'itr' = standard intensive trauma retreat,
    // 'kair' = ketamine-assisted intensive retreat. Only therapists with
    // therapists.kair_eligible=true may be assigned to a kair retreat.
    program: retreatProgram('program').notNull().default('itr'),

    plannedFullDays: integer('planned_full_days').notNull().default(0),
    plannedHalfDays: integer('planned_half_days').notNull().default(0),
    paymentMethod: paymentMethod('payment_method').notNull().default('ach'),

    // Snapshotted from therapist defaults (or sliding-scale override) at
    // retreat creation. Live pricing_config edits never affect existing rows.
    fullDayRateCents: integer('full_day_rate_cents').notNull(),
    halfDayRateCents: integer('half_day_rate_cents'),
    achDiscountPct: numeric('ach_discount_pct', { precision: 5, scale: 4 })
      .notNull(),
    totalPlannedCents: integer('total_planned_cents').notNull(),
    depositCents: integer('deposit_cents').notNull(),

    // Admin-only billing classification. Never rendered client-side.
    pricingBasis: pricingBasis('pricing_basis').notNull().default('standard'),
    pricingNotes: text('pricing_notes'),

    // Filled at completion (M5).
    actualFullDays: integer('actual_full_days'),
    actualHalfDays: integer('actual_half_days'),
    totalActualCents: integer('total_actual_cents'),

    scheduledStartDate: date('scheduled_start_date'),
    scheduledEndDate: date('scheduled_end_date'),

    /**
     * Unguessable URL slug for the public client surface (`/c/[token]/*`).
     * Generated by lib/tokens.ts. 24 random bytes base64url-encoded ⇒ 32 chars.
     */
    clientToken: text('client_token').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    clientTokenIdx: uniqueIndex('retreats_client_token_idx').on(t.clientToken),
  }),
);

/**
 * Versioned, immutable consent templates. Once `published_at` is set, the
 * row never changes; new versions are new rows. A retreat snapshots which
 * template versions are required at the moment of creation
 * (`retreat_required_consents` join table).
 */
export const consentTemplates = pgTable(
  'consent_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(), // 'informed-consent' | 'npp' | 'emergency-contact-release'
    version: integer('version').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    /**
     * Schema for evidence_blob captured during signing — array of
     * { key, label, kind: 'checkbox'|'text'|'choice'|'longtext'|'date',
     *   required?: boolean, options?: string[] }
     */
    requiredFields: jsonb('required_fields').notNull().default(sql`'[]'::jsonb`),
    requiresSignature: boolean('requires_signature').notNull().default(true),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nameVersionIdx: uniqueIndex('consent_templates_name_version_idx').on(
      t.name,
      t.version,
    ),
  }),
);

/**
 * Per-retreat snapshot of which template versions are required at the
 * moment a retreat enters `awaiting_consents`. Future template versions
 * don't affect in-flight clients.
 */
export const retreatRequiredConsents = pgTable(
  'retreat_required_consents',
  {
    retreatId: uuid('retreat_id')
      .notNull()
      .references(() => retreats.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => consentTemplates.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex('retreat_required_consents_pk').on(
      t.retreatId,
      t.templateId,
    ),
  }),
);

export const consentSignatures = pgTable('consent_signatures', {
  id: uuid('id').primaryKey().defaultRandom(),
  retreatId: uuid('retreat_id')
    .notNull()
    .references(() => retreats.id, { onDelete: 'cascade' }),
  templateId: uuid('template_id')
    .notNull()
    .references(() => consentTemplates.id),
  // PHI: signed name + intake answers
  signedName: text('signed_name').notNull(),
  signedAt: timestamp('signed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  /**
   * Captured intake answers (gender, pronouns, comms permissions, NPP-version
   * acknowledgment, signature image data URL, etc.) keyed by template's
   * required_fields. Treated as PHI.
   */
  evidenceBlob: jsonb('evidence_blob').notNull().default(sql`'{}'::jsonb`),
  // gs:// path inside itr-consents-{env} bucket. Bucket is CMEK-bound.
  pdfStoragePath: text('pdf_storage_path'),
});

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  retreatId: uuid('retreat_id').references(() => retreats.id, {
    onDelete: 'cascade',
  }),
  actorType: actorType('actor_type').notNull(),
  // Therapist UUID, retreat client_token, stripe event id, or null for system.
  actorId: text('actor_id'),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * email_log — outbound notification audit trail.
 *
 * PHI flag (audit #29): `recipient` is PHI when `retreat_id` is non-null,
 * because the join exposes which client / therapist a given email address
 * belongs to. Export pipelines must redact `recipient` (or hash it) when
 * leaving the production project. Rows with `retreat_id IS NULL` (system
 * notifications to team@itr) are non-PHI and may be exported as-is.
 *
 * Status semantics:
 *   sent       — gmail.send() returned a messageId; message_id is set
 *   delivered  — webhook/poll confirmed delivery (not currently emitted)
 *   bounced    — DSN matched against message_id; bounced_at + bounce_reason set
 *   complained — spam-flagged (not currently emitted)
 *   failed     — send raised; message_id is null (audit #28)
 *
 * message_id is the RFC 5322 Message-ID header we generate at send time and
 * pass to Gmail in the raw payload. The cron-scan-bounces job parses inbound
 * DSN messages and matches their In-Reply-To header against this column.
 */
export const emailLog = pgTable('email_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  retreatId: uuid('retreat_id').references(() => retreats.id, {
    onDelete: 'set null',
  }),
  recipient: text('recipient').notNull(),
  templateName: text('template_name').notNull(),
  messageId: text('message_id'),
  status: emailStatus('status').notNull().default('sent'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  bouncedAt: timestamp('bounced_at', { withTimezone: true }),
  bounceReason: text('bounce_reason'),
});

/**
 * notify(event_type, retreat_id) → fan out to these recipients. Editable in
 * admin (M7). Seed defaults: team@itr for everything; per-therapist row for
 * action-required events only.
 */
export const notificationRecipients = pgTable(
  'notification_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    email: text('email').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventEmailIdx: uniqueIndex('notification_recipients_event_email_idx').on(
      t.eventType,
      t.email,
    ),
  }),
);

/**
 * Stripe Customer linkage. One row per client. Stripe Customer holds
 * non-PHI billing info only (DESIGN.md §16). The default payment method
 * id is the saved card/ACH source we re-charge off-session at retreat
 * completion.
 */
export const stripeCustomers = pgTable('stripe_customers', {
  clientId: uuid('client_id')
    .primaryKey()
    .references(() => clients.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  defaultPaymentMethodId: text('default_payment_method_id'),
  paymentMethodType: text('payment_method_type'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Payment intents and refunds (DESIGN.md §9). One row per Stripe
 * PaymentIntent or Refund attempt. Idempotency on stripe_payment_intent_id
 * (unique) so duplicate webhooks don't double-write.
 *
 * `updated_at` semantics (audit #41): bumped on every status flip and on
 * every retry — so it can advance well past `retreats.updated_at` for the
 * same retreat (e.g. a retry cron run that doesn't transition the retreat).
 * See the retreats comment block for the parallel-timelines rule.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    retreatId: uuid('retreat_id')
      .notNull()
      .references(() => retreats.id, { onDelete: 'cascade' }),
    kind: paymentKind('kind').notNull(),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    stripeChargeId: text('stripe_charge_id'),
    amountCents: integer('amount_cents').notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // PARTIAL unique on PI id, scoped to non-refund kinds. Refund rows
    // legitimately reuse the original PI (Stripe refunds target a PI),
    // so excluding kind='refund' lets multiple refunds against the same
    // PI co-exist (M9 fix; migration 0005).
    paymentIntentIdx: uniqueIndex('payments_stripe_payment_intent_idx')
      .on(t.stripePaymentIntentId)
      .where(sql`${t.kind} <> 'refund'`),
  }),
);

export type Therapist = typeof therapists.$inferSelect;
export type Location = typeof locations.$inferSelect;
export type PricingConfig = typeof pricingConfig.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type Retreat = typeof retreats.$inferSelect;
export type ConsentTemplate = typeof consentTemplates.$inferSelect;
export type ConsentSignature = typeof consentSignatures.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type EmailLog = typeof emailLog.$inferSelect;
export type NotificationRecipient = typeof notificationRecipients.$inferSelect;
export type StripeCustomer = typeof stripeCustomers.$inferSelect;
export type Payment = typeof payments.$inferSelect;
