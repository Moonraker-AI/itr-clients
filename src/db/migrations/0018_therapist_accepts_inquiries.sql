-- Add `accepts_inquiries` to therapists: whether the person is offered as a
-- selectable therapist on the public contact-inquiry form (and may receive
-- inquiries). This is intentionally separate from `active`, which gates
-- auth/roster membership. Platform-owner admins (Chris) must stay active to
-- log in but are not real therapists, so they should not be a public contact
-- option. Real therapists who happen to be admins (Bambi) keep this true.
--
-- IF NOT EXISTS keeps the migration idempotent on a manual catch-up.

ALTER TABLE "therapists"
  ADD COLUMN IF NOT EXISTS "accepts_inquiries" boolean NOT NULL DEFAULT true;

-- Remove Chris Morin (platform owner, not a treating therapist) from the
-- public contact form. His row stays active so his admin login is unaffected.
UPDATE "therapists" SET "accepts_inquiries" = false WHERE "slug" = 'chris-morin';
