-- Swap notification recipients from team@ → support@ AND drop the
-- per-therapist seed rows.
--
-- - team@intensivetherapyretreat.com was a placeholder seed in M2; the
--   real shared inbox is support@.
-- - The M2 seed also inserted a row per therapist for action-required
--   events (`deposit_paid`, `final_charge_failed`), which caused every
--   therapist to receive notifications for every retreat. Therapists are
--   now resolved per-retreat at send time via retreat.therapist_id, so
--   the per-therapist seed rows are redundant and noisy.
--
-- Idempotent: re-runs on a DB that's already on the new shape are a no-op.

DELETE FROM notification_recipients
WHERE email <> 'support@intensivetherapyretreat.com';
--> statement-breakpoint
INSERT INTO notification_recipients (event_type, email, active)
SELECT ev, 'support@intensivetherapyretreat.com', true
FROM unnest(ARRAY[
  'consent_package_sent',
  'consents_signed',
  'deposit_paid',
  'dates_confirmed',
  'in_progress',
  'completion_submitted',
  'final_charged',
  'final_charge_failed',
  'cancelled'
]::text[]) AS ev
ON CONFLICT (event_type, email) DO UPDATE SET active = true;
