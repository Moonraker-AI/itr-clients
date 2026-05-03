-- Swap notification recipients from team@ → support@.
--
-- The team@intensivetherapyretreat.com mailbox was a placeholder seed in M2;
-- the real shared inbox is support@. Idempotent: re-running on a DB that's
-- already on support@ is a no-op.

DELETE FROM notification_recipients
WHERE email = 'team@intensivetherapyretreat.com';
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
