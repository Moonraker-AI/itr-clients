-- KAIR program support (v0.23.0). Adds retreat_program enum + retreats.program
-- column, plus therapist columns for KAIR eligibility, KAIR-specific pricing,
-- and Stripe Connect routing for the future payout pipeline (Phase C).

CREATE TYPE retreat_program AS ENUM ('itr', 'kair');
--> statement-breakpoint
ALTER TABLE retreats ADD COLUMN program retreat_program NOT NULL DEFAULT 'itr';
--> statement-breakpoint
ALTER TABLE therapists
  ADD COLUMN kair_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN kair_full_day_cents integer,
  ADD COLUMN kair_half_day_cents integer,
  ADD COLUMN stripe_connect_account_id text,
  ADD COLUMN therapist_payout_pct numeric(5,2) NOT NULL DEFAULT 80;
--> statement-breakpoint
-- Backfill KAIR eligibility + rates for the 4 trained therapists. Uniform
-- $1850 / $1000 from the program rate sheet.
UPDATE therapists
   SET kair_eligible = true,
       kair_full_day_cents = 185000,
       kair_half_day_cents = 100000
 WHERE email IN (
   'bambi@intensivetherapyretreat.com',
   'amy@intensivetherapyretreat.com',
   'nikki@intensivetherapyretreat.com',
   'vickie@intensivetherapyretreat.com'
 );
--> statement-breakpoint
-- Backfill Stripe Connect IDs from operational spreadsheet. Ross stays NULL
-- (paid directly outside Connect). Chris stays NULL (platform owner row).
UPDATE therapists SET stripe_connect_account_id = 'acct_1JxjLSDGT6bz5bfX', therapist_payout_pct = 100 WHERE email = 'bambi@intensivetherapyretreat.com';
--> statement-breakpoint
UPDATE therapists SET stripe_connect_account_id = 'acct_1M9ZMUD89kXLgstF' WHERE email = 'amy@intensivetherapyretreat.com';
--> statement-breakpoint
UPDATE therapists SET stripe_connect_account_id = 'acct_1MBPA3RcqDP3hXuU' WHERE email = 'brian@intensivetherapyretreat.com';
--> statement-breakpoint
UPDATE therapists SET stripe_connect_account_id = 'acct_1MC6ZrD3Yl7yuaca' WHERE email = 'jordan@intensivetherapyretreat.com';
--> statement-breakpoint
UPDATE therapists SET stripe_connect_account_id = 'acct_1M9X2mDFNkk4EY1n' WHERE email = 'nikki@intensivetherapyretreat.com';
--> statement-breakpoint
UPDATE therapists SET stripe_connect_account_id = 'acct_1MC55tD6y6uH6AtZ' WHERE email = 'vickie@intensivetherapyretreat.com';
