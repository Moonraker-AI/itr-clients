#!/usr/bin/env bash
#
# Bootstrap Cloud Monitoring for itr-client-hq.
#
# Idempotent — safe to re-run on the same project. Creates (or updates):
#   1. The "Support inbox" notification channel for support@moonraker.ai
#   2. Five log-based metrics (ready_db / stripe_webhook / final_charge
#      CRITICAL / cron_auth / cron_scan_bounces)
#   3. All YAML alerting policies under infra/alerting/, with ${CHANNEL}
#      substituted for the channel id resolved at apply time
#
# Apply order matters: channel → metrics → policies. Policies reference both.
#
# Usage:
#   scripts/apply-monitoring.sh dev
#   scripts/apply-monitoring.sh prod

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

CHANNEL_EMAIL="${ALERT_EMAIL:-support@moonraker.ai}"
CHANNEL_NAME="Support inbox"
ALERTING_DIR="$(cd "$(dirname "$0")/../infra/alerting" && pwd)"

echo "==> project=${PROJECT_ID}"
echo "==> channel email=${CHANNEL_EMAIL}"
echo "==> alerting dir=${ALERTING_DIR}"

gcloud services enable monitoring.googleapis.com --project="${PROJECT_ID}" >/dev/null

# ---------------------------------------------------------------------------
# 1. Notification channel (idempotent — looked up by displayName).
# ---------------------------------------------------------------------------
CHANNEL=$(gcloud alpha monitoring channels list \
  --project="${PROJECT_ID}" \
  --filter="displayName=\"${CHANNEL_NAME}\"" \
  --format='value(name)' \
  | head -n1)

if [[ -z "${CHANNEL}" ]]; then
  echo "==> creating notification channel ${CHANNEL_NAME}"
  gcloud alpha monitoring channels create \
    --project="${PROJECT_ID}" \
    --display-name="${CHANNEL_NAME}" \
    --type=email \
    --channel-labels=email_address="${CHANNEL_EMAIL}" >/dev/null
  CHANNEL=$(gcloud alpha monitoring channels list \
    --project="${PROJECT_ID}" \
    --filter="displayName=\"${CHANNEL_NAME}\"" \
    --format='value(name)' \
    | head -n1)
fi
echo "==> channel id=${CHANNEL}"

# ---------------------------------------------------------------------------
# 2. Log-based metrics.
# ---------------------------------------------------------------------------
create_metric() {
  local name="$1"
  local description="$2"
  local filter="$3"

  if gcloud logging metrics describe "${name}" --project="${PROJECT_ID}" \
       >/dev/null 2>&1; then
    echo "==> log metric ${name} already present, updating filter"
    gcloud logging metrics update "${name}" \
      --project="${PROJECT_ID}" \
      --description="${description}" \
      --log-filter="${filter}" >/dev/null
  else
    echo "==> creating log metric ${name}"
    gcloud logging metrics create "${name}" \
      --project="${PROJECT_ID}" \
      --description="${description}" \
      --log-filter="${filter}" >/dev/null
  fi
}

create_metric "ready_db_check_failed" \
  "DB check on /ready failed" \
  'resource.type="cloud_run_revision"
   resource.labels.service_name="itr-client-hq"
   jsonPayload.message="ready_db_check_failed"'

create_metric "stripe_webhook_failed" \
  "Stripe webhook handler raised" \
  'resource.type="cloud_run_revision"
   resource.labels.service_name="itr-stripe-webhook"
   jsonPayload.message="stripe_webhook_dispatch_failed"'

create_metric "final_charge_db_write_failed_after_succeeded" \
  "CRITICAL: Stripe charged but our DB write failed" \
  'resource.type="cloud_run_revision"
   jsonPayload.message="CRITICAL_final_charge_succeeded_but_db_write_failed"'

create_metric "cron_auth_failed" \
  "Cron shared-secret mismatch" \
  'resource.type="cloud_run_revision"
   jsonPayload.message="cron_shared_secret_mismatch"'

create_metric "cron_scan_bounces_failed" \
  "Bounce-scan cron handler raised (likely DWD scope or Gmail quota)" \
  'resource.type="cloud_run_revision"
   jsonPayload.message="cron_scan_bounces_failed"'

# ---------------------------------------------------------------------------
# 3. Alerting policies. Substitute ${CHANNEL} into each YAML on the fly so we
#    do not commit the resolved channel id (project-specific) into the repo.
# ---------------------------------------------------------------------------
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

for f in "${ALERTING_DIR}"/*.yaml; do
  base=$(basename "${f}")
  rendered="${TMP_DIR}/${base}"
  CHANNEL="${CHANNEL}" envsubst '${CHANNEL}' < "${f}" > "${rendered}"

  display=$(awk -F': ' '/^displayName:/ {sub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}' "${rendered}")
  existing=$(gcloud alpha monitoring policies list \
    --project="${PROJECT_ID}" \
    --filter="displayName=\"${display}\"" \
    --format='value(name)' \
    | head -n1)

  if [[ -n "${existing}" ]]; then
    echo "==> updating policy ${display}"
    gcloud alpha monitoring policies update "${existing}" \
      --project="${PROJECT_ID}" \
      --policy-from-file="${rendered}" >/dev/null
  else
    echo "==> creating policy ${display}"
    gcloud alpha monitoring policies create \
      --project="${PROJECT_ID}" \
      --policy-from-file="${rendered}" >/dev/null
  fi
done

# ---------------------------------------------------------------------------
# 4. Dashboard. Looked up by displayName for idempotency.
# ---------------------------------------------------------------------------
DASHBOARD_FILE="${ALERTING_DIR}/dashboard.json"
DASHBOARD_NAME="itr-client-hq overview"
existing_dashboard=$(gcloud monitoring dashboards list \
  --project="${PROJECT_ID}" \
  --filter="displayName=\"${DASHBOARD_NAME}\"" \
  --format='value(name)' \
  | head -n1)

if [[ -n "${existing_dashboard}" ]]; then
  echo "==> updating dashboard ${DASHBOARD_NAME}"
  gcloud monitoring dashboards update "${existing_dashboard}" \
    --project="${PROJECT_ID}" \
    --config-from-file="${DASHBOARD_FILE}" >/dev/null
else
  echo "==> creating dashboard ${DASHBOARD_NAME}"
  gcloud monitoring dashboards create \
    --project="${PROJECT_ID}" \
    --config-from-file="${DASHBOARD_FILE}" >/dev/null
fi

echo
echo "==> done. View at:"
echo "    https://console.cloud.google.com/monitoring/alerting/policies?project=${PROJECT_ID}"
echo "    https://console.cloud.google.com/monitoring/dashboards?project=${PROJECT_ID}"
