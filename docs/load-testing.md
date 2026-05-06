# Load testing

Quantify the system's breakpoints before they happen for real.
[k6](https://k6.io) is the chosen tool — single binary, JavaScript test
scripts, sensible defaults.

## Install

```bash
# Linux (apt)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# macOS
brew install k6
```

## Targets

Run against **dev**, never against prod. Cloud Run autoscales but the
backing Cloud SQL instance is shared and a sustained load test against
prod will degrade real-client traffic.

```bash
export BASE_URL=https://itr-client-hq-buejbopu5q-uc.a.run.app
```

## Scripts

### `tests/load/baseline.js` — `/health`

Floor: how many req/s a Cloud Run instance can serve when work ≈ 0.
Useful as a denominator when interpreting heavier tests.

```bash
k6 run tests/load/baseline.js
# Defaults: 20 VUs, 30s. Override via K6_VUS=50 K6_DURATION=2m
```

Expected on dev: a single warm instance ≥ 1k req/s w/ p95 < 50ms. If
you see Cloud Run scaling up multiple instances, raise VUs to push
harder.

### `tests/load/static.js` — CSS + fonts + logo

Measures the static-asset path. Headers say `immutable`, but Cloud Run
doesn't have a built-in CDN for `*.run.app` URLs — every request hits
the container. The only cache is the browser's. So this measures
in-process file serving + `serveStatic` overhead.

```bash
k6 run tests/load/static.js
```

Expected: p95 < 150ms for all three assets. If logo.png is materially
slower than app.css, suspect file size (logo is ~10 KB vs CSS ~26 KB —
should be similar).

### `tests/load/public-status.js` — `/c/<TOKEN>`

Heaviest public read path: 4 SELECTs + JSX render. Use to find:
- Cloud SQL connection-pool exhaustion (default pool size in
  `db/client.ts` — check what `MAX_CONNECTIONS` resolves to)
- N+1 latency creep
- Cloud Run cold-start frequency under burst (p99 spikes)

**Pre-step:** generate a token.

```bash
# Either:
npm run smoke:retreat        # local against dev DB via cloud-sql-proxy

# Or manually via the admin UI:
# 1. Sign in to /admin/login
# 2. Click "+ New client"
# 3. Submit
# 4. On the resulting detail page, copy the Public client URL token segment
```

```bash
TOKEN=<paste here> k6 run tests/load/public-status.js
# Defaults: 5 VUs, 1 min. Bumping VUs past 60 will hit the rate-limiter (60/min/IP).
```

## Interpreting

### Pass criteria

Every script ships with `thresholds`. k6 exits non-zero on any breach.
Default thresholds (intentionally conservative):

- `http_req_failed: rate < 0.01` — error rate under 1%
- `http_req_duration: p95 < 200ms` for /health, < 800ms for /c/<token>

### What to do when a threshold breaks

1. **5xx spike in baseline**: Cloud Run is restarting under load
   (OOM, init failure). Check Cloud Logging; bump
   `--memory` on the service.
2. **p95 latency creep on public-status**: DB-bound. Check Cloud SQL
   Insights for slow queries; consider an index on
   `retreat_required_consents.retreat_id` if it isn't there.
3. **Connection pool errors** ("too many connections"): the pg pool
   default is conservative. Either raise pool size in db/client.ts
   (and bump Cloud SQL `max_connections` in flags) or reduce concurrency.
4. **429 rate-limiting from /c/* under load**: expected — that's the
   `lib/rate-limit.ts` middleware doing its job. Lower VUs or
   temporarily raise the cap on dev.

## Cloud Run autoscaling notes

- Default concurrency: 80 reqs per instance
- Default min-instances: 0 (cold starts under burst)
- Default max-instances: 100

For load testing it's useful to pin min-instances to 1 to remove cold
starts from the measurement:

```bash
gcloud run services update itr-client-hq \
  --region=us-central1 \
  --min-instances=1 \
  --project=<DEV_PROJECT>

# Don't forget to revert after the test
gcloud run services update itr-client-hq \
  --region=us-central1 \
  --min-instances=0 \
  --project=<DEV_PROJECT>
```

## What's NOT in this runbook

- Stripe-side load (sandbox accounts have low rate limits)
- Webhook ingestion under load (the webhook service is
  `itr-stripe-webhook`, separate from the main app — different
  scripts, not yet written)
- Authenticated `/admin/*` routes — would require seeding session
  cookies via the Firebase flow, more setup than warranted for V1
