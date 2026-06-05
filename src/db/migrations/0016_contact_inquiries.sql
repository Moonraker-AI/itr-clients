DO $$ BEGIN
  CREATE TYPE "public"."inquiry_status" AS ENUM (
    'new',
    'contacted',
    'follow_up_needed',
    'consult_scheduled',
    'converted',
    'archived',
    'spam_duplicate'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "retreats"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "archived_by_therapist_id" uuid,
  ADD COLUMN IF NOT EXISTS "archive_reason" text;

DO $$ BEGIN
  ALTER TABLE "retreats"
    ADD CONSTRAINT "retreats_archived_by_therapist_id_therapists_id_fk"
    FOREIGN KEY ("archived_by_therapist_id")
    REFERENCES "public"."therapists"("id")
    ON DELETE set null
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "contact_inquiries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requested_therapist_id" uuid,
  "assigned_therapist_id" uuid,
  "status" "public"."inquiry_status" DEFAULT 'new' NOT NULL,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "email" text NOT NULL,
  "phone" text NOT NULL,
  "location" text NOT NULL,
  "timezone" text NOT NULL,
  "consultation_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "message" text,
  "heard_from" text,
  "consent_phone" boolean DEFAULT false NOT NULL,
  "consent_text" boolean DEFAULT false NOT NULL,
  "consent_email" boolean DEFAULT false NOT NULL,
  "policy_service_level" boolean DEFAULT false NOT NULL,
  "policy_financial" boolean DEFAULT false NOT NULL,
  "source_page" text,
  "source_key" text,
  "contact_hash" text NOT NULL,
  "message_hash" text,
  "ip_hash" text,
  "user_agent" text,
  "converted_retreat_id" uuid,
  "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "contacted_at" timestamp with time zone,
  "archived_at" timestamp with time zone,
  "last_action_by_therapist_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "contact_inquiries"
    ADD CONSTRAINT "contact_inquiries_requested_therapist_id_therapists_id_fk"
    FOREIGN KEY ("requested_therapist_id")
    REFERENCES "public"."therapists"("id")
    ON DELETE set null
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "contact_inquiries"
    ADD CONSTRAINT "contact_inquiries_assigned_therapist_id_therapists_id_fk"
    FOREIGN KEY ("assigned_therapist_id")
    REFERENCES "public"."therapists"("id")
    ON DELETE set null
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "contact_inquiries"
    ADD CONSTRAINT "contact_inquiries_converted_retreat_id_retreats_id_fk"
    FOREIGN KEY ("converted_retreat_id")
    REFERENCES "public"."retreats"("id")
    ON DELETE set null
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "contact_inquiries"
    ADD CONSTRAINT "contact_inquiries_last_action_by_therapist_id_therapists_id_fk"
    FOREIGN KEY ("last_action_by_therapist_id")
    REFERENCES "public"."therapists"("id")
    ON DELETE set null
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "contact_inquiry_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "inquiry_id" uuid NOT NULL,
  "actor_therapist_id" uuid,
  "event_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "contact_inquiry_events"
    ADD CONSTRAINT "contact_inquiry_events_inquiry_id_contact_inquiries_id_fk"
    FOREIGN KEY ("inquiry_id")
    REFERENCES "public"."contact_inquiries"("id")
    ON DELETE cascade
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "contact_inquiry_events"
    ADD CONSTRAINT "contact_inquiry_events_actor_therapist_id_therapists_id_fk"
    FOREIGN KEY ("actor_therapist_id")
    REFERENCES "public"."therapists"("id")
    ON DELETE set null
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "retreats_archived_idx"
  ON "retreats" ("archived_at");

CREATE INDEX IF NOT EXISTS "contact_inquiries_assigned_status_created_idx"
  ON "contact_inquiries" ("assigned_therapist_id", "status", "created_at");

CREATE INDEX IF NOT EXISTS "contact_inquiries_contact_hash_created_idx"
  ON "contact_inquiries" ("contact_hash", "created_at");

CREATE INDEX IF NOT EXISTS "contact_inquiries_message_hash_created_idx"
  ON "contact_inquiries" ("message_hash", "created_at");

CREATE INDEX IF NOT EXISTS "contact_inquiries_converted_retreat_idx"
  ON "contact_inquiries" ("converted_retreat_id");

CREATE INDEX IF NOT EXISTS "contact_inquiry_events_inquiry_created_idx"
  ON "contact_inquiry_events" ("inquiry_id", "created_at");
