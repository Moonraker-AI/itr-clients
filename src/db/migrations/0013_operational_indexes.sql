-- Operational indexes for admin detail/dashboard, public consent status,
-- cron scans, and email bounce correlation. Tables are still small in prod,
-- so normal CREATE INDEX is acceptable during the deploy migration window.

CREATE INDEX IF NOT EXISTS retreats_state_idx
  ON retreats (state);

CREATE INDEX IF NOT EXISTS retreats_therapist_state_updated_idx
  ON retreats (therapist_id, state, updated_at);

CREATE INDEX IF NOT EXISTS retreats_state_scheduled_start_idx
  ON retreats (state, scheduled_start_date)
  WHERE state = 'scheduled';

CREATE INDEX IF NOT EXISTS consent_signatures_retreat_template_idx
  ON consent_signatures (retreat_id, template_id);

CREATE INDEX IF NOT EXISTS audit_events_retreat_created_idx
  ON audit_events (retreat_id, created_at);

CREATE INDEX IF NOT EXISTS email_log_retreat_sent_idx
  ON email_log (retreat_id, sent_at);

CREATE INDEX IF NOT EXISTS email_log_message_status_idx
  ON email_log (message_id, status)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_retreat_kind_created_idx
  ON payments (retreat_id, kind, created_at);
