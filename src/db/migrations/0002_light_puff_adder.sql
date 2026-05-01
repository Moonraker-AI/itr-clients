CREATE TYPE "public"."payment_kind" AS ENUM('deposit', 'final', 'refund');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retreat_id" uuid NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_charge_id" text,
	"amount_cents" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_customers" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"default_payment_method_id" text,
	"payment_method_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripe_payment_intent_idx" ON "payments" USING btree ("stripe_payment_intent_id");