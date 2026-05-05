# Monitoring + alerting runbook (P1 #9)

Cloud Monitoring policies you should configure on the prod project before
real clients use the system. Dev should mirror most of these too —
catch regressions during the smoke flow.

All commands assume `gcloud config set project <PROD_PROJECT>` first.

---

## 1. Notification channel

Create one channel for the on-call email (support@moonraker.ai) so every
policy below can reference it. One-time setup:

```bash
# Email channel for the support inbox.
gcloud alpha monitoring channels create \
  --display-name="Support inbox" \
  --type=email \
  --channel-labels=email_address=support@moonraker.ai

# Capture the channel id for use below.
CHANNEL=$(gcloud alpha monitoring channels list \
  --filter='displayName="Support inbox"' \
  --format='value(name)')
echo "$CHANNEL"
# → projects/<PROJECT>/notificationChannels/<id>
```

Optional: add a Slack channel later via the same command with `--type=slack`
once a webhook URL is provisioned.

---

## 2. Alerting policies

Each policy is one YAML file. Save under `infra/alerting/` and apply with:

```bash
gcloud alpha monitoring policies create --policy-from-file=infra/alerting/<file>.yaml
```

### a. 5xx error rate > 5% over 5 min

```yaml
displayName: Cloud Run 5xx rate (itr-client-hq)
combiner: OR
notificationChannels: [REPLACE_WITH_CHANNEL]
conditions:
  - displayName: 5xx > 5%
    conditionThreshold:
      filter: |
        resource.type = "cloud_run_revision"
        AND resource.labels.service_name = "itr-client-hq"
        AND metric.type = "run.googleapis.com/request_count"
        AND metric.labels.response_code_class = "5xx"
      aggregations:
        - alignmentPeriod: 60s
          perSeriesAligner: ALIGN_RATE
          crossSeriesReducer: REDUCE_SUM
      comparison: COMPARISON_GT
      thresholdValue: 0.05
      duration: 300s
      trigger: { count: 1 }
```

### b. p95 request latency > 2s for 5 min

```yaml
displayName: Cloud Run p95 latency (itr-client-hq)
combiner: OR
notificationChannels: [REPLACE_WITH_CHANNEL]
conditions:
  - displayName: p95 > 2s
    conditionThreshold:
      filter: |
        resource.type = "cloud_run_revision"
        AND resource.labels.service_name = "itr-client-hq"
        AND metric.type = "run.googleapis.com/request_latencies"
      aggregations:
        - alignmentPeriod: 60s
          perSeriesAligner: ALIGN_PERCENTILE_95
          crossSeriesReducer: REDUCE_MEAN
      comparison: COMPARISON_GT
      thresholdValue: 2000
      duration: 300s
      trigger: { count: 1 }
```

### c. /ready DB check failing

Log-based metric — counts every `ready_db_check_failed` line. Create the
metric first, then alert on it.

```bash
# 1. Create the log-based counter.
gcloud logging metrics create ready_db_check_failed \
  --description="DB check on /ready failed" \
  --log-filter='resource.type="cloud_run_revision"
    resource.labels.service_name="itr-client-hq"
    jsonPayload.message="ready_db_check_failed"'
```

```yaml
# 2. Alert when the metric exceeds 0 in a 5-min window.
displayName: /ready DB failures (itr-client-hq)
combiner: OR
notificationChannels: [REPLACE_WITH_CHANNEL]
conditions:
  - displayName: any ready failure in 5 min
    conditionThreshold:
      filter: |
        resource.type = "cloud_run_revision"
        AND metric.type = "logging.googleapis.com/user/ready_db_check_failed"
      aggregations:
        - alignmentPeriod: 60s
          perSeriesAligner: ALIGN_DELTA
          crossSeriesReducer: REDUCE_SUM
      comparison: COMPARISON_GT
      thresholdValue: 0
      duration: 300s
      trigger: { count: 1 }
```

### d. Stripe webhook failures

```bash
gcloud logging metrics create stripe_webhook_failed \
  --description="Stripe webhook handler raised" \
  --log-filter='resource.type="cloud_run_revision"
    resource.labels.service_name="itr-stripe-webhook"
    jsonPayload.message="unhandled_error"'
```

Alert: any non-zero count in 10 min → page. Webhook drops mean Stripe will
retry, but a sustained failure indicates a real bug.

### e. Final-charge failures (business signal)

Already logged as `markFinalChargeFailed` via state-machine. The
`final_charge_failed` notification email goes to support automatically —
the alerting policy is a backup signal in case email delivery is broken.

```bash
gcloud logging metrics create final_charge_failed \
  --description="off-session final charge failed"   \
  --log-filter='resource.type="cloud_run_revision"
    jsonPayload.message="final_charge_db_write_starting"
    OR jsonPayload.message="CRITICAL_final_charge_succeeded_but_db_write_failed"'
```

The CRITICAL_* line is the worst case — Stripe charged but DB write
failed. Alert on count > 0 with severity = critical.

### f. Cron route auth failures

The cron routes have a shared-secret belt + Cloud Run IAM suspenders.
A spike in `cron_auth_failed` log lines means someone's probing the
cron endpoints (or the secret rotated and a job is stale).

```bash
gcloud logging metrics create cron_auth_failed \
  --description="Cron shared-secret mismatch"  \
  --log-filter='resource.type="cloud_run_revision"
    jsonPayload.message="cron_shared_secret_mismatch"'
```

---

## 3. Dashboards

Create one dashboard combining the above signals:

```bash
gcloud monitoring dashboards create --config-from-file=infra/alerting/dashboard.json
```

Recommended widgets:
- Request rate (split by status code class)
- Request latency (p50, p95, p99)
- Container CPU + memory
- Pod count (instances)
- Log-based metrics from §2
- Cloud SQL instance CPU + connections
- Stripe webhook backlog (custom metric, future)

---

## 4. SLOs (informal targets)

| Signal | Target | Notes |
|--------|--------|-------|
| Availability (2xx + 3xx / total) | 99.5% / month | ~3.5h budget |
| p95 request latency | < 500 ms | most routes are SQL + render only |
| /admin/login render | < 300 ms | gates user friction |
| Stripe webhook ack | < 1 s | Stripe retries on slow ack |
| Email delivery success | 99% | watch email_log.status |

Don't formalise these as Google SLOs (extra service to manage) until you
have enough traffic to make the math meaningful.

---

## 5. Reading the signals

When an alert fires:

1. Check `https://console.cloud.google.com/monitoring/alerting/incidents`
2. Click into the incident → Logs panel auto-filters to the matching
   service + time window.
3. Cross-reference the `trace` field on the log line with Cloud Trace to
   see the upstream caller.
4. If the alert is for a state-transition or webhook failure, also pull
   the affected `retreatId` from the log payload and check `audit_events`
   in the DB — the full transition payload lives there with the actor +
   timestamp.

---

## 6. What's not covered here

- Stripe-side dashboards (Disputes, Refund volume) — view in the Stripe
  dashboard, not Cloud Monitoring.
- Cloud Run cold-start frequency — visible in Cloud Run UI per-revision.
- Identity Platform quota usage — visible in Firebase console.
- DB query slow-log — Cloud SQL Insights tab, separate from app monitoring.
