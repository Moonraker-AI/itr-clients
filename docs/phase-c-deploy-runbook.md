# Phase C deploy runbook

**Scope:** Stripe Connect destination charges + payouts ledger + fee
deduction + reversible refunds + drop-Sentry. Versions v0.25.0 through
v0.28.0.

**Migrations introduced:**
- `0010_payouts.sql` — payout_status enum + payouts table (v0.25.0)
- `0011_payout_pct_default.sql` — flip therapist_payout_pct default 80→60
  + UPDATE existing 80% rows (v0.27.0)

## Order of operations

The Cloud Run service queries the new `payouts` table starting in
v0.26.0 (admin UI loads payouts rows on `/admin/payouts` and the
clients-detail Payments card). It must NOT receive traffic running
v0.26.0 code before migration 0010 lands.

```
1. Merge PRs in stack order: #81 → #82 → #83 → #84 (retarget bases as each lands)
2. Apply migration 0010 to dev
3. Smoke v0.25 + v0.26 on dev
4. Apply migration 0011 to dev
5. Smoke v0.27 fee math on dev
6. Apply 0010 + 0011 to prod (in that order)
7. Tag v0.25.0 → approve prod deploy → wait for completion
8. Tag v0.26.0 → approve → wait
9. Tag v0.27.0 → approve → wait
10. Tag v0.28.0 → approve → wait
11. Walk through prod smoke (run-smoke-seed.sh + manual flow)
```

Tag-deploys are sequential because each version assumes the prior is in
prod. Do not skip versions; do not batch tags.

## Step-by-step

### 1. Merge PR stack

```bash
# After GitHub review of #81:
gh pr merge 81 --squash
# Then retarget #82:
gh pr edit 82 --base main
# Wait for CI green on #82, then:
gh pr merge 82 --squash
gh pr edit 83 --base main
gh pr merge 83 --squash
gh pr edit 84 --base main
gh pr merge 84 --squash
```

### 2. Apply migration 0010 to dev

```bash
# From repo root, with LOCAL_DB_URL pointing at dev (or use the
# itr-smoke-seed Cloud Run Job pattern from M17 if private-IP).
LOCAL_DB_URL='postgres://...itr-clients-dev/itr' npm run db:migrate
```

Verify:

```sql
-- Connect to dev DB
\d payouts
SELECT enumlabel FROM pg_enum WHERE enumtypid = 'payout_status'::regtype;
-- Expect: pending, in_transit, paid, failed, reversed
```

### 3. Smoke v0.25 + v0.26 on dev

After tagging v0.25.0 + v0.26.0 (or by running the dev branch directly
if you've merged main):

- `/admin/payouts` page renders empty table (no charges yet)
- Trigger a deposit checkout for a test client — verify in Stripe
  dashboard that the PaymentIntent has `transfer_data.destination` +
  `application_fee_amount` set (using v0.25.0 fee model — this will
  be wrong-by-fee until 0011 + v0.27.0 are applied; that's expected).
- After charge clears, verify a `payouts` row appears via
  `/admin/payouts` and inline on the retreat detail page.
- Trigger `transfer.reversed` manually via Stripe CLI:
  `stripe trigger transfer.reversed` — confirm row status flips.

### 4. Apply migration 0011 to dev

```bash
LOCAL_DB_URL='postgres://...itr-clients-dev/itr' npm run db:migrate
```

Verify:

```sql
SELECT slug, therapist_payout_pct FROM therapists ORDER BY slug;
-- Expect: bambi 100, others 60
```

### 5. Smoke v0.27 fee math on dev

After tagging v0.27.0 + redeploying:

- New $1000 deposit on a 60% therapist: PaymentIntent should show
  `application_fee_amount = 41758` (Amy, Brian, Jordan, Nikki, Vickie).
- New $1000 deposit on Bambi: `application_fee_amount = 2930`.
- Refund the test deposit: customer gets gross back; connected
  account debited; platform debited the app fee. Verify on Stripe
  dashboard's Connect → Connected accounts → Bambi (or whoever) →
  Balance.

### 6. Apply 0010 + 0011 to prod

```bash
LOCAL_DB_URL='postgres://...itr-clients-prod-phi/itr' npm run db:migrate
```

(Or equivalent via the Cloud Run Job pattern. Migrations run in order;
Drizzle's `__drizzle_migrations` table tracks state, so re-running is
safe.)

Verify the same shapes as dev steps 2 + 4 against prod.

### 7–10. Tag + approve sequentially

```bash
git checkout main && git pull
git tag v0.25.0 && git push origin v0.25.0
# GitHub Actions: deploy.yml fires; prod env requires manual approval.
# Approve at https://github.com/Moonraker-AI/itr-clients/actions
# Wait for completion (~5–10 min). Verify revision lands in Cloud Run.

git tag v0.26.0 && git push origin v0.26.0
# Approve, wait, verify.

git tag v0.27.0 && git push origin v0.27.0
# Approve, wait, verify.

git tag v0.28.0 && git push origin v0.28.0
# Approve, wait, verify.
```

### 11. Prod smoke

```bash
bash scripts/run-smoke-seed.sh prod
# Stdout prints Public URL + Admin URL.
```

Walk the consent flow → checkout → confirm dates → complete (or cancel
to clean up). Verify in Stripe Connect dashboard that the platform's
Connect dashboard shows the test transfer with the correct
application_fee_amount.

## Rollback

If a deploy goes sideways:

```bash
# Revert the Cloud Run revision to the prior tag.
gcloud run services update-traffic itr-client-hq \
  --region=us-central1 \
  --project=itr-clients-prod-phi \
  --to-revisions=<prev-revision-id>=100
```

Migrations are forward-only (Drizzle convention). To roll back schema:

- 0011 rollback: `UPDATE therapists SET therapist_payout_pct = 80
  WHERE therapist_payout_pct = 60 AND slug NOT IN ('bambi');
  ALTER TABLE therapists ALTER COLUMN therapist_payout_pct SET DEFAULT 80;`
  (manual SQL; do NOT delete the migrations row — let it stand.)
- 0010 rollback: `DROP TABLE payouts; DROP TYPE payout_status;`
  (do this only if no traffic has hit v0.26.0+ code.)

If you've already taken charges on v0.27.0's fee-deducted model, do NOT
roll back; reconcile via the v0.29.0 true-up path instead.

## Post-deploy verification

- Cloud Error Reporting: filter `serviceContext.service:itr-client-hq*`
  for the past hour; confirm no spike.
- `/admin/payouts`: confirm rows are appearing as new charges clear.
- `/admin/pricing`: edit a payout_pct value (revert it after) to
  confirm the form submits and the audit log records the change.
- Refund a small test charge on Bambi's Connect: verify customer +
  Bambi + platform balances all moved correctly.

## First-prod-refund verification (Stripe fee policy)

The first time you refund a destination-charge payment on prod, log
into the Stripe dashboard and check whether the original processing
fee was refunded to your platform balance. Stripe's policy historically
was "fee not refunded"; this may have changed. If fees ARE refunded,
update `docs/error-reporter.md`'s refund note + the v0.27.0 PR comment
that flagged this.
