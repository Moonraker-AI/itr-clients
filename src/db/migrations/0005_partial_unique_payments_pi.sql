-- Make the payments(stripe_payment_intent_id) unique index PARTIAL: only
-- enforce uniqueness on rows where kind != 'refund'. Refund rows reuse
-- the original PI id (Stripe refunds target a PI), and pre-this-migration
-- the first refund INSERT would throw a unique-constraint violation
-- AFTER Stripe had already moved money — leaving DB and Stripe out of sync.
--
-- Idempotent: drop-and-recreate.

DROP INDEX IF EXISTS payments_stripe_payment_intent_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX payments_stripe_payment_intent_idx
  ON payments (stripe_payment_intent_id)
  WHERE kind <> 'refund';
