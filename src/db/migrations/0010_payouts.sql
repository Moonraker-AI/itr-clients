-- Phase C (v0.25.0). Stripe Connect payouts: ledger of transfer_data legs of
-- destination charges. One payouts row per Stripe transfer.created event we
-- observe. Status mirrors Stripe's transfer lifecycle.
--
-- Charge flow note: with destination charges (transfer_data[destination] +
-- application_fee_amount) Stripe creates the transfer automatically at
-- capture; we don't issue separate transfers.create calls. This table
-- records what Stripe did so admins + ops can reconcile without leaving
-- the app.

CREATE TYPE payout_status AS ENUM (
  'pending',
  'in_transit',
  'paid',
  'failed',
  'reversed'
);
--> statement-breakpoint
CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retreat_id uuid REFERENCES retreats(id) ON DELETE SET NULL,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  therapist_id uuid NOT NULL REFERENCES therapists(id),
  stripe_transfer_id text UNIQUE,
  destination_account_id text NOT NULL,
  amount_cents integer NOT NULL,
  status payout_status NOT NULL DEFAULT 'pending',
  failure_code text,
  failure_message text,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX payouts_retreat_idx ON payouts(retreat_id);
--> statement-breakpoint
CREATE INDEX payouts_therapist_idx ON payouts(therapist_id);
