#!/usr/bin/env bash
#
# Audit #28 + #18 — operational alerts for the notification + retry paths.
#
# Provisions two independent log-based metric / alert pairs:
#
#   1. `itr-notify-send-failures` (audit #28)
#        Counts `notify_send_failed` ERROR log entries (notifications.ts:230).
#        Pages when Gmail/Workspace delivery is broken — without it,
#        individual failures only show up in `email_log.status` long after
#        the client experience has degraded.
#
#   2. `itr-final-charge-retry-exhausted` (audit #18)
#        Counts `CRITICAL_final_charge_retry_exhausted` ERROR log entries
#        (state-machine.ts: markFinalChargeFailed when attempt >= 3).
#        Pages on the FIRST occurrence — every exhausted retreat needs
#        manual recovery (Stripe portal, payment update, or refund).
#        This is the in-band signal so the alert still fires when the
#        notify() email path itself is down.
#
# Idempotent: re-running updates each metric/policy in place.
#
# Usage:
#   scripts/m7-create-notification-alarm.sh dev
#   scripts/m7-create-notification-alarm.sh prod
#
# Required env (or pass on CLI):
#   ITR_DEV_PROJECT_ID    (only needed for `dev`)
#   ITR_PROD_PROJECT_ID   (only needed for `prod`)
#   ITR_ALERT_EMAIL       — email to wire into the alerting policy.
#                            Defaults to support@moonraker.ai.

set -euo pipefail

ENV_NAME="${1:-}"
case "${ENV_NAME}" in
  dev)
    PROJECT_ID="${ITR_DEV_PROJECT_ID:-itr-clients-dev}"
    ;;
  prod)
    PROJECT_ID="${ITR_PROD_PROJECT_ID:-itr-clients-prod-phi}"
    ;;
  *)
    echo "usage: $0 dev|prod" >&2
    exit 2
    ;;
esac

ALERT_EMAIL="${ITR_ALERT_EMAIL:-support@moonraker.ai}"
METRIC_NAME="itr-notify-send-failures"
POLICY_NAME="itr-notify-send-failures-alert"

echo "==> project=${PROJECT_ID} alert_email=${ALERT_EMAIL}"

# 1. Log-based metric. Filter is intentionally tight — we only count the
#    notify_send_failed marker, not every ERROR-severity row, so the
#    metric stays meaningful as the codebase grows.
METRIC_FILTER='resource.type="cloud_run_revision"
severity=ERROR
jsonPayload.message="notify_send_failed"'

if gcloud logging metrics describe "${METRIC_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> updating existing metric ${METRIC_NAME}"
  gcloud logging metrics update "${METRIC_NAME}" \
    --project="${PROJECT_ID}" \
    --description="ITR notify_send_failed ERROR log entries (notifications.ts:230)" \
    --log-filter="${METRIC_FILTER}" \
    --quiet
else
  echo "==> creating metric ${METRIC_NAME}"
  gcloud logging metrics create "${METRIC_NAME}" \
    --project="${PROJECT_ID}" \
    --description="ITR notify_send_failed ERROR log entries (notifications.ts:230)" \
    --log-filter="${METRIC_FILTER}"
fi

# 2. Notification channel. Cloud Monitoring requires a channel resource
#    we can attach to the alert policy. Look up by display-name to keep
#    idempotent across re-runs.
CHANNEL_NAME=$(gcloud alpha monitoring channels list \
  --project="${PROJECT_ID}" \
  --filter="type=email AND labels.email_address=${ALERT_EMAIL}" \
  --format='value(name)' 2>/dev/null | head -n1 || true)

if [[ -z "${CHANNEL_NAME}" ]]; then
  echo "==> creating notification channel for ${ALERT_EMAIL}"
  CHANNEL_NAME=$(gcloud alpha monitoring channels create \
    --project="${PROJECT_ID}" \
    --display-name="ITR ops alerts (${ALERT_EMAIL})" \
    --type=email \
    --channel-labels="email_address=${ALERT_EMAIL}" \
    --format='value(name)')
else
  echo "==> reusing channel ${CHANNEL_NAME}"
fi

# 3. Alert policy. Threshold: more than 3 failures aggregated over 10
#    minutes triggers. Tuned conservatively because notify failures are
#    sticky — a Gmail outage produces a sustained burst, while a single
#    transient bounce should not page.
POLICY_FILE=$(mktemp)
cat >"${POLICY_FILE}" <<EOF
{
  "displayName": "${POLICY_NAME}",
  "documentation": {
    "content": "ITR notify_send_failed log entries exceeded threshold. Check Cloud Logging for jsonPayload.message=notify_send_failed and the contained 'event' + 'retreatId'. Common causes: Gmail SA key expired, recipient bounce storm, Workspace API quota hit.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "notify_send_failed > 3 over 10m",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${METRIC_NAME}\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 3,
        "duration": "600s",
        "aggregations": [
          {
            "alignmentPeriod": "600s",
            "perSeriesAligner": "ALIGN_SUM"
          }
        ]
      }
    }
  ],
  "notificationChannels": ["${CHANNEL_NAME}"],
  "alertStrategy": {
    "autoClose": "86400s"
  }
}
EOF

EXISTING_POLICY=$(gcloud alpha monitoring policies list \
  --project="${PROJECT_ID}" \
  --filter="displayName=${POLICY_NAME}" \
  --format='value(name)' 2>/dev/null | head -n1 || true)

if [[ -n "${EXISTING_POLICY}" ]]; then
  echo "==> updating existing policy ${EXISTING_POLICY}"
  gcloud alpha monitoring policies update "${EXISTING_POLICY}" \
    --project="${PROJECT_ID}" \
    --policy-from-file="${POLICY_FILE}" \
    --quiet
else
  echo "==> creating policy ${POLICY_NAME}"
  gcloud alpha monitoring policies create \
    --project="${PROJECT_ID}" \
    --policy-from-file="${POLICY_FILE}"
fi

rm -f "${POLICY_FILE}"

# 4. Second metric + policy: final-charge retry exhaustion (audit #18).
#    Targets the redundant in-band signal that fires from
#    state-machine.ts:markFinalChargeFailed when attempt >= 3.
EXHAUST_METRIC="itr-final-charge-retry-exhausted"
EXHAUST_POLICY="itr-final-charge-retry-exhausted-alert"
EXHAUST_FILTER='resource.type="cloud_run_revision"
severity=ERROR
jsonPayload.message="CRITICAL_final_charge_retry_exhausted"'

if gcloud logging metrics describe "${EXHAUST_METRIC}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> updating existing metric ${EXHAUST_METRIC}"
  gcloud logging metrics update "${EXHAUST_METRIC}" \
    --project="${PROJECT_ID}" \
    --description="ITR retreats with 3 failed final-charge attempts (state-machine.ts: CRITICAL_final_charge_retry_exhausted)" \
    --log-filter="${EXHAUST_FILTER}" \
    --quiet
else
  echo "==> creating metric ${EXHAUST_METRIC}"
  gcloud logging metrics create "${EXHAUST_METRIC}" \
    --project="${PROJECT_ID}" \
    --description="ITR retreats with 3 failed final-charge attempts (state-machine.ts: CRITICAL_final_charge_retry_exhausted)" \
    --log-filter="${EXHAUST_FILTER}"
fi

# Threshold: any (>0) occurrence over 5 min triggers. Each exhausted
# retreat needs human action regardless of frequency.
EXHAUST_POLICY_FILE=$(mktemp)
cat >"${EXHAUST_POLICY_FILE}" <<EOF
{
  "displayName": "${EXHAUST_POLICY}",
  "documentation": {
    "content": "ITR final-charge retry attempts exhausted (3/3) for one or more retreats. Manual recovery required: open the admin detail page for the retreatId in the log payload, contact the client via the Stripe customer portal, or process a refund. See state-machine.ts: CRITICAL_final_charge_retry_exhausted for the source line.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "final_charge_retry_exhausted > 0 over 5m",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${EXHAUST_METRIC}\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0,
        "duration": "0s",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_SUM"
          }
        ]
      }
    }
  ],
  "notificationChannels": ["${CHANNEL_NAME}"],
  "alertStrategy": {
    "autoClose": "86400s"
  }
}
EOF

EXISTING_EXHAUST_POLICY=$(gcloud alpha monitoring policies list \
  --project="${PROJECT_ID}" \
  --filter="displayName=${EXHAUST_POLICY}" \
  --format='value(name)' 2>/dev/null | head -n1 || true)

if [[ -n "${EXISTING_EXHAUST_POLICY}" ]]; then
  echo "==> updating existing policy ${EXISTING_EXHAUST_POLICY}"
  gcloud alpha monitoring policies update "${EXISTING_EXHAUST_POLICY}" \
    --project="${PROJECT_ID}" \
    --policy-from-file="${EXHAUST_POLICY_FILE}" \
    --quiet
else
  echo "==> creating policy ${EXHAUST_POLICY}"
  gcloud alpha monitoring policies create \
    --project="${PROJECT_ID}" \
    --policy-from-file="${EXHAUST_POLICY_FILE}"
fi

rm -f "${EXHAUST_POLICY_FILE}"

echo "==> done. View policies in console:"
echo "    https://console.cloud.google.com/monitoring/alerting/policies?project=${PROJECT_ID}"
