-- v0.27.0. Flip default therapist payout split from 80/20 to 60/40 to match
-- ITR's actual revenue-share agreement. Existing therapists still on the
-- legacy 80% default are migrated down to 60. Bambi at 100% (full payout)
-- stays untouched — she keeps her 100/0 deal.

ALTER TABLE therapists
  ALTER COLUMN therapist_payout_pct SET DEFAULT 60;
--> statement-breakpoint
UPDATE therapists
   SET therapist_payout_pct = 60
 WHERE therapist_payout_pct = 80;
