-- v0.28.27. Adds an `awaiting_dates` state between `awaiting_deposit`
-- and `scheduled` so the client UI can distinguish "we're still waiting
-- on you" from "you're done, ball's in the therapist's court."
--
-- Postgres lets ADD VALUE run inside a transaction starting from PG 12;
-- the drizzle migrate runner is on PG 16 here so this applies cleanly.
-- IF NOT EXISTS makes the migration idempotent if it's reapplied after
-- a manual catch-up.

ALTER TYPE retreat_state ADD VALUE IF NOT EXISTS 'awaiting_dates' BEFORE 'scheduled';
