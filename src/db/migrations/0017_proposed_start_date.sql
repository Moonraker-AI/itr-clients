-- Adds an optional `proposed_start_date` to retreats: the therapist's
-- intended retreat start, captured at intake on /admin/clients/new and
-- editable on the retreat detail page before dates are confirmed.
--
-- Informational only. It does NOT gate any state transition. The
-- authoritative scheduled date stays `scheduled_start_date`, set later
-- via the confirmDates transition. IF NOT EXISTS keeps the migration
-- idempotent on a manual catch-up.

ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "proposed_start_date" date;
