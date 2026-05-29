-- Add Hannah Tosi to the therapist roster. She uses Amy Shuman's standard
-- ITR rates, is not KAIR eligible, and routes payments to her own connected
-- Stripe account.

WITH source AS (
  SELECT
    'hannah-tosi'::text AS slug,
    'Hannah Tosi'::text AS full_name,
    'hannah@intensivetherapyretreat.com'::text AS email,
    'therapist'::therapist_role AS role,
    COALESCE(loc.id, amy.primary_location_id) AS primary_location_id,
    COALESCE(amy.default_full_day_cents, 160000)::integer AS default_full_day_cents,
    COALESCE(amy.default_half_day_cents, 85500)::integer AS default_half_day_cents,
    false::boolean AS kair_eligible,
    NULL::integer AS kair_full_day_cents,
    NULL::integer AS kair_half_day_cents,
    'acct_1M9snERmtU1QaQqW'::text AS stripe_connect_account_id,
    60::numeric(5,2) AS therapist_payout_pct,
    true::boolean AS active
  FROM (SELECT 1) AS one
  LEFT JOIN therapists amy ON amy.slug = 'amy-shuman'
  LEFT JOIN locations loc ON loc.slug = 'northampton-ma'
),
updated_by_email AS (
  UPDATE therapists t
     SET slug = s.slug,
         full_name = s.full_name,
         role = s.role,
         primary_location_id = s.primary_location_id,
         default_full_day_cents = s.default_full_day_cents,
         default_half_day_cents = s.default_half_day_cents,
         kair_eligible = s.kair_eligible,
         kair_full_day_cents = s.kair_full_day_cents,
         kair_half_day_cents = s.kair_half_day_cents,
         stripe_connect_account_id = s.stripe_connect_account_id,
         therapist_payout_pct = s.therapist_payout_pct,
         active = s.active
    FROM source s
   WHERE t.email = s.email
  RETURNING t.id
)
INSERT INTO therapists (
  slug,
  full_name,
  email,
  role,
  primary_location_id,
  default_full_day_cents,
  default_half_day_cents,
  kair_eligible,
  kair_full_day_cents,
  kair_half_day_cents,
  stripe_connect_account_id,
  therapist_payout_pct,
  active
)
SELECT
  slug,
  full_name,
  email,
  role,
  primary_location_id,
  default_full_day_cents,
  default_half_day_cents,
  kair_eligible,
  kair_full_day_cents,
  kair_half_day_cents,
  stripe_connect_account_id,
  therapist_payout_pct,
  active
FROM source
WHERE NOT EXISTS (SELECT 1 FROM updated_by_email)
ON CONFLICT (slug) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  email = EXCLUDED.email,
  role = EXCLUDED.role,
  primary_location_id = EXCLUDED.primary_location_id,
  default_full_day_cents = EXCLUDED.default_full_day_cents,
  default_half_day_cents = EXCLUDED.default_half_day_cents,
  kair_eligible = EXCLUDED.kair_eligible,
  kair_full_day_cents = EXCLUDED.kair_full_day_cents,
  kair_half_day_cents = EXCLUDED.kair_half_day_cents,
  stripe_connect_account_id = EXCLUDED.stripe_connect_account_id,
  therapist_payout_pct = EXCLUDED.therapist_payout_pct,
  active = EXCLUDED.active;
