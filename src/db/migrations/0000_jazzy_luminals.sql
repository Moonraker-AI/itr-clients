CREATE TYPE "public"."therapist_role" AS ENUM('admin', 'therapist');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"address" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pricing_config" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"ach_discount_pct" numeric(5, 4) DEFAULT 0.0300 NOT NULL,
	"default_deposit_days" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "therapists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"slug" text NOT NULL,
	"email" text NOT NULL,
	"role" "therapist_role" DEFAULT 'therapist' NOT NULL,
	"primary_location_id" uuid,
	"default_full_day_cents" integer NOT NULL,
	"default_half_day_cents" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "therapists_slug_unique" UNIQUE("slug"),
	CONSTRAINT "therapists_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pricing_config" ADD CONSTRAINT "pricing_config_updated_by_therapists_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."therapists"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "therapists" ADD CONSTRAINT "therapists_primary_location_id_locations_id_fk" FOREIGN KEY ("primary_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
