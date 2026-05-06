# Smoke test — end-to-end click-through

Run this checklist in **dev** before any real client touches prod. It
exercises the full happy path plus 1–2 failure branches. Allow ~30 minutes.

## 0. Prereqs (one time)

### a. Discover the dev project + instance

```bash
# Lists both projects (dev + prod). Pick the dev one.
gcloud projects list --filter='project_id ~ itr'

# Set as default for the rest of this session
export DEV_PROJECT=<dev-project-id-from-above>

# The instance name is fixed across envs
export DEV_INSTANCE="$DEV_PROJECT:us-central1:itr-postgres-dev"
echo "$DEV_INSTANCE"
```

### b. Pull the dev DSN out of Secret Manager

The `db-url` secret holds the full Cloud-SQL-socket DSN. We swap the
unix-socket host for `localhost:5432` to talk through the proxy.

```bash
# Full secret value (single line)
DB_URL=$(gcloud secrets versions access latest --secret=db-url --project="$DEV_PROJECT")

# Rewrite for local proxy: replace `?host=/cloudsql/...` with localhost:5432
LOCAL_DB_URL=$(echo "$DB_URL" | sed -E 's|@/([^?]+)\?host=[^&]+|@localhost:5432/\1|')
echo "$LOCAL_DB_URL"
# → postgres://itr-app:<encoded-pwd>@localhost:5432/itr_clients
```

(Save to `.env.local` or `export LOCAL_DB_URL=...` in the shell that runs the seeder.)

### c. Start the Cloud SQL proxy

In a **separate terminal**, leave this running:

```bash
cloud-sql-proxy --address 0.0.0.0 --port 5432 "$DEV_INSTANCE"
```

(Install via `gcloud components install cloud-sql-proxy` if you don't have it.)

### d. Verify Stripe test mode (P0 #3)

```bash
gcloud secrets versions access latest --secret=stripe-secret-key --project="$DEV_PROJECT" | head -c 8
# → sk_test_   ← dev should be this
```

For prod: same command with `--project=$PROD_PROJECT`. Should print `sk_live_`.

## 1. Seed a smoke retreat

```bash
PUBLIC_BASE_URL=https://itr-client-hq-buejbopu5q-uc.a.run.app \
  npm run smoke:retreat
```

Output ends with a `Public URL`, `Sign URL`, and `Admin URL`. Copy them.

> The seeder creates a fresh client each run with email
> `smoke-<unix>@moonraker.ai`. Old smoke retreats can be cancelled via the
> admin Cancel form or deleted directly in SQL.

## 2. Sign in to admin

1. Open `https://itr-client-hq-buejbopu5q-uc.a.run.app/admin/login`
2. Sign in with `chris@intensivetherapyretreat.com`
3. Land on dashboard. Confirm:
   - Sidebar shows **ITR Clients** + logo
   - Smoke retreat row visible with state `awaiting_consents`
   - Theme toggle flips light/dark + persists across reload
   - Sign out button works (then sign back in)
4. Click anywhere on the smoke row → opens detail page

## 3. Walk through admin detail page

- Public client URL card shows the live token
- Required consents card lists all templates (none signed yet)
- No "Confirm dates" CTA yet (gated on deposit)

## 4. Open the public client surface (incognito tab)

Open the `Public URL` from step 1 in an **incognito** window so you experience the client view without admin cookies.

1. Status page renders with logo + "Hi Smoke" + therapist name
2. All required documents listed as "not yet signed" (or "informational" for NPP)
3. CTA: "Continue with <next consent title>"
4. Click through. For each signature-required template:
   - Read the body
   - Fill required fields
   - Sign in the canvas with mouse/finger
   - Type printed name
   - Submit → returns to status page with that document marked ✓ signed
5. After last signature, status page shows: "All consents signed. Deposit checkout link is coming next."

## 5. Trigger deposit (admin-side)

The deposit-link email sends automatically once consents complete. To smoke the checkout flow without waiting for email:

1. Visit `<Public URL>/checkout` directly in the incognito tab → 302 to Stripe
2. Use a test card:
   - **Success**: `4242 4242 4242 4242`, any future expiry, any CVC, any zip
   - **3DS required**: `4000 0027 6000 3184` (triggers `requires_action` on the final charge later)
   - **Decline**: `4000 0000 0000 0002`
3. Pay → redirected back to `/c/:token/checkout/success` ("Thanks — your deposit is received.")
4. Refresh status page — webhook should have recorded the payment

## 6. Confirm dates + run the retreat

Back in admin tab:

1. Refresh detail page — "Confirm retreat dates" CTA should now show
2. Click → enter dates (start = today, end = today + N days)
3. Submit → should email `dates_confirmed` with .ics attachment to the smoke email (real Gmail, will bounce on `moonraker.ai` unless that mailbox exists — check email_log table for `status` regardless)
4. State flips to `scheduled`
5. The state cron flips `scheduled` → `in_progress` once start date ≤ today (run once a minute, so wait or trigger via curl to `/api/cron/state-transitions` w/ shared secret)

## 7. Complete the retreat

1. Once state is `in_progress`, "Complete retreat" CTA shows
2. Click → enter actual day counts → submit
3. Server attempts off-session final charge against the saved card
   - With `4242` deposit: success, state → `completed`, receipt sent
   - With `4000 0027` deposit: `requires_action`, state → `final_charge_failed`

## 8. (If 3DS path) Recover the failed charge

1. Open `<Public URL>/confirm-payment` in incognito
2. Click "Confirm payment" → 3DS challenge
3. Approve → redirect to `/payment-updated`
4. Wait for retry cron OR trigger manually → state → `completed`

## 9. (Optional) Refund + cancel paths

1. Detail page → Refund → pick the deposit row → enter amount or leave blank for full → submit
2. Refund row appears in payments table; state unchanged
3. Cancel → check confirmation box → submit → state → `cancelled`

## What to watch for

- Every page renders w/ logo + correct theme + no console errors
- Email log row inserted for every transition email (status=`succeeded` or `failed` if Gmail rejects the smoke recipient)
- Audit log row for every state transition
- Webhook events visible in Cloud Logging (`severity=INFO`, `message=stripe_webhook_received`)
- No PHI leaks in logs (search for the smoke email — should be redacted)

## After the test

Delete the smoke client + retreat in SQL, or leave it (each run uses a unique email). The data is dev-only.

## Promotion to prod

Only after every step above passes in dev:

1. Repeat steps 4–8 in prod against `clients.intensivetherapyretreat.com` using a real card and a real `$1` test (Stripe minimum). You'll be billed $1 — refund yourself via the admin Refund form afterward.
2. Verify the receipt email lands in the inbox you specified.
3. Cancel the prod smoke retreat to remove it from the dashboard.
