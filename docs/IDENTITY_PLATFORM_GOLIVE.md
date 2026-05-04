# Identity Platform Go-Live (Path A)

This is the runbook for flipping `AUTH_ENABLED=1` in dev and prod. It is the
single remaining gate before real client/therapist traffic — every other M0–M9
piece is shipped and live.

The auth code (M8) is already deployed and currently no-ops to a synthetic
admin context. Identity Platform must be provisioned in each GCP project,
GitHub repo vars must be set, then a redeploy will pick up the new env.

## Pre-flight

- v0.8.4 in prod, both envs.
- `infra/cloudbuild.yaml` already plumbs `AUTH_ENABLED`, `FIREBASE_*`, and
  `PUBLIC_BASE_URL` substitutions. Empty values = auth disabled (current
  state).
- `state-machine.ts:119` — `publicBaseUrl()` throws if `AUTH_ENABLED=1` and
  `PUBLIC_BASE_URL` is unset. Server refuses to start in that case (M9 fix
  #45 tripwire).
- `src/lib/auth.ts` — `requireAuth` middleware no-ops to synthetic admin
  when `AUTH_ENABLED` is empty/`0`.

## Per-environment steps

Run for `dev` first, smoke test, then repeat for `prod`.

### 1. Provision Identity Platform

```bash
scripts/m8-provision-identity-platform.sh dev
```

This enables the APIs and grants `roles/firebaseauth.viewer` to the runtime
SA. The script then prints the manual console checklist:

1. Enable Identity Platform (Tier 1 free).
2. Add Google sign-in provider.
3. Restrict authorized domains: `intensivetherapyretreat.com` + the Cloud
   Run hostname.
4. Register a Firebase web app, copy `apiKey` + `authDomain`.

### 2. Bind GitHub repo vars

Settings → Secrets and variables → Actions → Variables. Set:

| Var name | Value |
|----------|-------|
| `FIREBASE_API_KEY_DEV` | apiKey from Firebase web config |
| `FIREBASE_AUTH_DOMAIN_DEV` | authDomain from Firebase web config |
| `PUBLIC_BASE_URL_DEV` | `https://itr-client-hq-buejbopu5q-uc.a.run.app` |
| `AUTH_ENABLED_DEV` | `1` |

For prod (after dev smoke passes):

| Var name | Value |
|----------|-------|
| `FIREBASE_API_KEY_PROD` | apiKey from prod Firebase web config |
| `FIREBASE_AUTH_DOMAIN_PROD` | authDomain from prod Firebase web config |
| `PUBLIC_BASE_URL_PROD` | `https://itr-client-hq-bxs22x5kya-uc.a.run.app` (or custom domain when wired) |
| `AUTH_ENABLED_PROD` | `1` |

> Note: `FIREBASE_API_KEY` is a browser-public value. It is bound as a
> plain env var, not via Secret Manager.

### 3. Redeploy

- **Dev**: push a no-op commit to `main` (or `gh workflow run Deploy`).
- **Prod**: tag a release. Use the next patch — the cloudbuild change is
  infra-only, no app code change.

  ```bash
  git tag -a v0.8.5 -m "chore: enable Identity Platform in prod"
  git push origin v0.8.5
  ```

### 4. Verify startup

```bash
gcloud run services describe itr-client-hq \
  --project=itr-clients-dev --region=us-central1 \
  --format='value(status.latestReadyRevisionName)'

gcloud logging read \
  "resource.type=cloud_run_revision AND severity>=WARNING" \
  --project=itr-clients-dev --limit=20 --freshness=10m
```

Expected: revision goes Ready, no `PUBLIC_BASE_URL is required` errors.

If the server fails to boot complaining about `PUBLIC_BASE_URL`, the repo
var didn't propagate. Re-check that the var is set at the **repository**
scope (not environment), and that the workflow ran after the var was set.

### 5. Smoke test sign-in

1. Open `${PUBLIC_BASE_URL}/login`.
2. Click Sign in with Google.
3. Use a `@intensivetherapyretreat.com` account.
4. Confirm landing on `/admin/dashboard` with the signed-in email shown.
5. Confirm a non-allowlisted Google account is rejected.

### 6. Stripe live-mode E2E (prod only)

After prod sign-in works, run a single real-client retreat through the
flow as the canary:

- Therapist creates retreat in dashboard.
- Client receives invite email, completes intake form.
- Client confirms dates → Stripe Checkout (live key).
- Auth-hold succeeds, session created.
- (Optional) trigger off-session final charge via state-cron.
- Confirm Gmail emails delivered, audit row in `email_log`.

## Rollback

If sign-in is broken in prod and clients are blocked:

1. Set `AUTH_ENABLED_PROD=0` in repo vars.
2. Trigger a redeploy: `gh workflow run Deploy --ref v0.8.5`.
3. Service falls back to synthetic admin (current state). All admin pages
   reachable only via Cloud Run IAM (which is the existing posture).

No data migration is needed for rollback — auth is purely runtime.

## Out of scope here

- Custom domain wiring (`*.intensivetherapyretreat.com`). When that lands,
  bump `PUBLIC_BASE_URL_PROD` to the custom origin and add the hostname to
  the Identity Platform authorized-domains list.
- Therapist allowlist editor in the dashboard. Currently the allowlist is
  domain-based (`@intensivetherapyretreat.com`); per-email gating is a
  future feature.
