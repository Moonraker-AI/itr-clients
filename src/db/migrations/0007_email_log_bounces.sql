-- Bounce tracking (P1 #10). Cron-scan-bounces matches inbound DSN messages
-- against email_log.message_id (an RFC 5322 Message-ID header we now generate
-- and pass through to Gmail at send time). Until this migration the column
-- held Gmail's internal numeric id, which is NOT what DSN In-Reply-To carries
-- — making bounce matching impossible. Old rows keep their internal ids; the
-- next send writes an RFC Message-ID and bounce matching becomes effective.

ALTER TABLE email_log RENAME COLUMN gmail_message_id TO message_id;
--> statement-breakpoint
ALTER TABLE email_log ADD COLUMN bounced_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE email_log ADD COLUMN bounce_reason text;
