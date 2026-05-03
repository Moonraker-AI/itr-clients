-- Add support@ as recipient for `final_charge_retry_exhausted` (M6).
-- Idempotent: ON CONFLICT keeps the row active.

INSERT INTO notification_recipients (event_type, email, active)
VALUES ('final_charge_retry_exhausted', 'support@intensivetherapyretreat.com', true)
ON CONFLICT (event_type, email) DO UPDATE SET active = true;
