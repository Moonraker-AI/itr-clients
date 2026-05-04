-- Add 'failed' to email_status enum so notify() can write a row when the
-- send call itself raises (network error, Gmail 4xx/5xx, etc.). Audit #28:
-- previously such failures only emitted a `notify_send_failed` ERROR log
-- with no email_log row, so there was no per-recipient durable record.
--
-- Postgres 12+ allows ALTER TYPE ADD VALUE inside a transaction provided
-- the new value isn't read in the same tx. This migration only adds the
-- value; the application reads it on subsequent statements.

ALTER TYPE email_status ADD VALUE IF NOT EXISTS 'failed';
