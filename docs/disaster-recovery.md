# Disaster recovery runbook

What to do when something breaks badly. Each section: detection → triage →
recovery → post-incident.

All commands assume `gcloud config set project <PROD_PROJECT>`. Capture
the actual project id from the GH workflow vars (`GCP_PROJECT_ID_PROD`).

---

## 1. Bad deploy → roll back

**Detection:**
- 5xx-rate alert (`docs/monitoring.md` policy a) fires
- Visual smoke fails immediately after a tagged release

**Recover (≤2 min):**

```bash
# List recent revisions
gcloud run revisions list --service=itr-client-hq --region=us-central1 --limit=5

# Roll all traffic to the previous revision
gcloud run services update-traffic itr-client-hq \
  --region=us-central1 \
  --to-revisions=<PREV_REVISION_NAME>=100
```

The previous revision is still warm (Cloud Run keeps recent revisions
ready) so failover is instant. Stripe webhook is a separate service —
roll it the same way against `itr-stripe-webhook`.

**Post-incident:**
- Open an issue with the failing tag + git SHA
- Revert the offending commit on main + ship a new tag (don't leave the
  bad image around with traffic 0 — re-tag means a clean state)

---

## 2. Cloud SQL outage / data corruption

### 2a. Transient connectivity blip

**Detection:**
- `/ready` alert fires
- Single retreat operation fails with `getaddrinfo` / `ECONNREFUSED`

**Recover:**
- Cloud Run pool auto-reconnects via @google-cloud/cloud-sql-connector.
  No manual action — wait 60s, alert should clear.
- If it persists, check Cloud SQL instance state:
  ```bash
  gcloud sql instances describe itr-postgres-prod --format='value(state)'
  ```
  If state != `RUNNABLE`, restart:
  ```bash
  gcloud sql instances restart itr-postgres-prod
  ```

### 2b. Data corruption / accidental delete (PITR restore)

**Detection:**
- Manual report ("the dashboard lost rows")
- Audit log shows unexpected `DELETE` or schema change

**Recover (15–60 min):**

Cloud SQL has continuous backups + 7-day point-in-time recovery on by
default. Restore to a NEW instance, then either swap or copy rows.

```bash
# Restore to a new instance at a specific timestamp (UTC)
gcloud sql instances clone itr-postgres-prod itr-postgres-prod-restore \
  --point-in-time='2026-05-06T03:30:00.000Z'

# Connect to the restored instance via proxy
cloud-sql-proxy --port 5433 <PROJECT>:us-central1:itr-postgres-prod-restore &

# psql to inspect
psql "postgres://itr-app:<pwd>@localhost:5433/itr_clients"
```

Two paths from here:
1. **Cherry-pick rows**: `pg_dump` specific tables from restored, `psql`
   them into prod. Safer for partial corruption.
2. **Promote restore as new prod**: stop the app, swap DB_URL secret to
   point at the restored instance, restart Cloud Run service. Use only
   if corruption is widespread.

**Post-incident:**
- Confirm `audit_events` row exists for the corrupting operation
- Tighten the responsible code path (transaction boundary? missing
  state-machine guard?)

---

## 3. Stripe webhook miss / replay

**Detection:**
- A `payment_intent.succeeded` happened in Stripe but state didn't advance
- Stripe Dashboard → Developers → Events → red "Failed" markers

**Recover:**

Stripe retries failed webhook deliveries automatically (8x over 3 days).
For deliveries that exhausted retries OR for events you want to re-process:

1. Stripe Dashboard → Developers → Webhooks → click the endpoint
2. Click any past event → **"Resend"**

The webhook handler is idempotent (keys on `payment_intent.id` for
deposits + `final:<retreatId>:N` for final charges) so re-sends are safe.

If Stripe webhook signing secret rotated and the handler is rejecting
all events:

```bash
# Rotate the secret in Secret Manager
gcloud secrets versions add stripe-webhook-secret --data-file=- <<< "<new-secret>"
# Cloud Run picks up the new version on next request — no redeploy needed
# because we use --set-secrets=...:latest
```

---

## 4. Gmail OAuth / DWD failure

**Detection:**
- `email_log.status = 'failed'` rows pile up
- `gmail_send_failed` log lines

**Recover:**

The Gmail wrapper uses Domain-Wide Delegation impersonating
`clients@intensivetherapyretreat.com` via a service account JSON key
stored in `gmail-service-account` secret.

**If the SA key was rotated:**
```bash
# 1. Generate a new key on the service account in the Workspace project
gcloud iam service-accounts keys create gmail-key.json \
  --iam-account=<gmail-sa>@<workspace-project>.iam.gserviceaccount.com

# 2. Upload to Secret Manager
gcloud secrets versions add gmail-service-account --data-file=gmail-key.json --project=<PROD_PROJECT>

# 3. Restart Cloud Run to pick up the new version
gcloud run services update itr-client-hq --region=us-central1 --tag=force-restart
gcloud run services update-traffic itr-client-hq --region=us-central1 --to-latest

# 4. Delete the local key file
rm gmail-key.json
```

**If DWD scopes changed in Workspace admin:**
- The SA needs `https://www.googleapis.com/auth/gmail.send` granted in
  Workspace Admin → Security → API Controls → Domain-wide Delegation
- Re-add the OAuth client ID with the scope; impersonation re-attaches
  on next request

**Backstop while diagnosing:**
- Notification emails are NOT load-bearing for the state machine — state
  transitions happen regardless. Failure = a missing notification.
- Manually email affected clients from the support inbox if needed.

---

## 5. Identity Platform sign-in broken

**Detection:**
- Admin reports "can't sign in"
- `/admin/login` renders the form but `signInWithPopup` errors

**Common causes:**
- `firebase-api-key` rotated → re-bind via deploy var `FIREBASE_API_KEY_PROD`
- Identity Platform tenant has the email domain restricted
- Runtime SA lost `firebaseauth.admin` IAM role (see
  `feedback_firebase_admin_iam.md` memory)

**Recover:**
1. Check Cloud Run env vars on the latest revision — confirm
   FIREBASE_API_KEY/AUTH_DOMAIN/PROJECT_ID are bound
2. Check IAM:
   ```bash
   gcloud projects get-iam-policy <PROD_PROJECT> \
     --flatten='bindings[].members' \
     --filter='bindings.members:itr-app@<PROD_PROJECT>.iam.gserviceaccount.com'
   ```
   Should include `roles/firebaseauth.admin`. If missing:
   ```bash
   gcloud projects add-iam-policy-binding <PROD_PROJECT> \
     --member='serviceAccount:itr-app@<PROD_PROJECT>.iam.gserviceaccount.com' \
     --role='roles/firebaseauth.admin'
   ```

**Backstop:** flip `AUTH_ENABLED=0` env var on the Cloud Run service to
fall back to the synthetic admin user (the Cloud Run IAM gate stays
active, so only people with `roles/run.invoker` can hit the service).
This is an "open the gate to ops only" emergency mode, not a permanent
fix.

---

## 6. Lost client_token recovery

**Symptom:** client says "I lost the email link to /c/<token>".

**Recover:**
- Token cannot be recovered (rotating one would invalidate any signed
  consents w/ that PDF metadata). Instead, send the same link from the
  admin detail page — token is shown there as the **Public client URL**.

If the client wants a fresh token (e.g. they think the email was
intercepted):
- This is currently not implemented. Workaround: cancel the retreat
  via /admin/clients/:id/cancel, create a new one via /admin/clients/new
  (gets a fresh token + new consent package email).

---

## 7. Region-wide GCP outage (us-central1)

**Detection:** all of the above broken at once + GCP status page red.

**Recover:** there is no automatic multi-region failover today. Manual
options:

- **Wait it out**: GCP us-central1 incidents typically <2h. Real client
  impact = consent flow blocked, no new retreats can be created.
- **Manual cutover** (~2h): bring up Cloud Run + Cloud SQL replica in a
  second region. Pre-requisites NOT in place today — would require:
  - Cloud SQL cross-region replica (currently disabled)
  - Cloud Run image present in second region's Artifact Registry
  - DNS swap for `clients.intensivetherapyretreat.com`

If the project takes off, schedule the multi-region migration as a
separate engagement.

---

## 8. Secret rotation drill

Once a quarter, rotate every secret + verify nothing breaks. Order:

1. `cron-shared-secret` (test cron jobs after)
2. `stripe-webhook-secret` (resend a Stripe event after)
3. `db-url` (only the password — rebuild DSN; restart Cloud Run)
4. `gmail-service-account` (per §4)
5. `firebase-api-key` is browser-public, but if regenerated in Firebase
   console, re-bind `FIREBASE_API_KEY_PROD` workflow var

For each: `gcloud secrets versions add <name> --data-file=-` then watch
the next deploy or trigger a service restart.

---

## 9. What is NOT in this runbook

- Stripe-side incidents (their dashboard, not yours)
- Workspace Gmail rate limits (separate quota, contact Workspace admin)
- Identity Platform quota exhaustion (separate quota, monitor in
  Firebase console)
- Real-time on-call rotation — when there's more than one human, build
  a PagerDuty integration on top of the alerting policies in
  `docs/monitoring.md`
