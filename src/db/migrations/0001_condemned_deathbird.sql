CREATE TYPE "public"."actor_type" AS ENUM('therapist', 'client', 'system', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('sent', 'delivered', 'bounced', 'complained');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('ach', 'card');--> statement-breakpoint
CREATE TYPE "public"."pricing_basis" AS ENUM('standard', 'sliding_scale', 'comp');--> statement-breakpoint
CREATE TYPE "public"."retreat_state" AS ENUM('draft', 'awaiting_consents', 'awaiting_deposit', 'scheduled', 'in_progress', 'awaiting_final_charge', 'completed', 'final_charge_failed', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retreat_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"dob" date,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"state_of_residence" text,
	"notes" text,
	"created_by_therapist_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consent_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retreat_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"signed_name" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"evidence_blob" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pdf_storage_path" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consent_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"body_markdown" text NOT NULL,
	"required_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_signature" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retreat_id" uuid,
	"recipient" text NOT NULL,
	"template_name" text NOT NULL,
	"gmail_message_id" text,
	"status" "email_status" DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"email" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retreat_required_consents" (
	"retreat_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retreats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"therapist_id" uuid NOT NULL,
	"location_id" uuid,
	"state" "retreat_state" DEFAULT 'draft' NOT NULL,
	"planned_full_days" integer DEFAULT 0 NOT NULL,
	"planned_half_days" integer DEFAULT 0 NOT NULL,
	"payment_method" "payment_method" DEFAULT 'ach' NOT NULL,
	"full_day_rate_cents" integer NOT NULL,
	"half_day_rate_cents" integer,
	"ach_discount_pct" numeric(5, 4) NOT NULL,
	"total_planned_cents" integer NOT NULL,
	"deposit_cents" integer NOT NULL,
	"pricing_basis" "pricing_basis" DEFAULT 'standard' NOT NULL,
	"pricing_notes" text,
	"actual_full_days" integer,
	"actual_half_days" integer,
	"total_actual_cents" integer,
	"scheduled_start_date" date,
	"scheduled_end_date" date,
	"client_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pricing_config" ADD COLUMN "affirm_uplift_pct" numeric(5, 4) DEFAULT 0.1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "pricing_config" ADD COLUMN "cancellation_admin_fee_cents" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clients" ADD CONSTRAINT "clients_created_by_therapist_id_therapists_id_fk" FOREIGN KEY ("created_by_therapist_id") REFERENCES "public"."therapists"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consent_signatures" ADD CONSTRAINT "consent_signatures_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consent_signatures" ADD CONSTRAINT "consent_signatures_template_id_consent_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."consent_templates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_log" ADD CONSTRAINT "email_log_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retreat_required_consents" ADD CONSTRAINT "retreat_required_consents_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retreat_required_consents" ADD CONSTRAINT "retreat_required_consents_template_id_consent_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."consent_templates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retreats" ADD CONSTRAINT "retreats_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retreats" ADD CONSTRAINT "retreats_therapist_id_therapists_id_fk" FOREIGN KEY ("therapist_id") REFERENCES "public"."therapists"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retreats" ADD CONSTRAINT "retreats_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consent_templates_name_version_idx" ON "consent_templates" USING btree ("name","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_recipients_event_email_idx" ON "notification_recipients" USING btree ("event_type","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retreat_required_consents_pk" ON "retreat_required_consents" USING btree ("retreat_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retreats_client_token_idx" ON "retreats" USING btree ("client_token");