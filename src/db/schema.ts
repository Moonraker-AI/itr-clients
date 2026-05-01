/**
 * Drizzle schema.
 *
 * M1: therapists, locations, pricing_config.
 * Later milestones add: clients, retreats, consents, payments, audit, email_log.
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
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const therapistRole = pgEnum('therapist_role', ['admin', 'therapist']);

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
  defaultDepositDays: integer('default_deposit_days').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => therapists.id),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Therapist = typeof therapists.$inferSelect;
export type Location = typeof locations.$inferSelect;
export type PricingConfig = typeof pricingConfig.$inferSelect;
