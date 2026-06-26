#!/usr/bin/env bash
#
# Create the Cloud Scheduler job that POSTs /api/cron/reconcile-deposits
# every 2 hours. This is the deposit safety net: it sweeps retreats stuck in
# `awaiting_deposit` and reconciles any that Stripe shows as paid (missed
# webhook, or ACH that cleared after the client left). Mirrors
# `m6-create-retry-scheduler.sh`. Idempotent.
#
# Pre-reqs already met by m4-create-scheduler.sh on first run:
#   - cloudscheduler.googleapis.com enabled
#   - Scheduler service agent has tokenCreator on the runtime SA
#   - Runtime SA has `roles/run.invoker` on `itr-client-hq`
# This script re-asserts those bindings idempotently in case it's run
# standalone in a fresh project.
#
# Usage:
#   scripts/create-reconcile-deposits-scheduler.sh dev
#   scripts/create-reconcile-deposits-scheduler.sh prod

set -euo pipefail

ENV_NAME="${1:-}"
case "${ENV_NAME}" in
  dev)
    PROJECT_ID="${ITR_DEV_PROJECT_ID:-itr-clients-dev}"
    SERVICE_URL="${ITR_DEV_SERVICE_URL:-https://itr-client-hq-buejbopu5q-uc.a.run.app}"
    ;;
  prod)
    PROJECT_ID="${ITR_PROD_PROJECT_ID:-itr-clients-prod-phi}"
    SERVICE_URL="${ITR_PROD_SERVICE_URL:-https://itr-client-hq-bxs22x5kya-uc.a.run.app}"
    ;;
  *)
    echo "usage: $0 dev|prod" >&2
    exit 2
    ;;
esac

REGION="${GCP_REGION:-us-central1}"
RUNTIME_SA="itr-app@${PROJECT_ID}.iam.gserviceaccount.com"
JOB_NAME="itr-reconcile-deposits"
TARGET_URL="${SERVICE_URL}/api/cron/reconcile-deposits"

echo "==> project=${PROJECT_ID} region=${REGION}"
echo "==> target=${TARGET_URL}"
echo "==> oidc SA=${RUNTIME_SA}"

# Idempotent: only useful in fresh projects, no-op once m4 script ran.
gcloud services enable cloudscheduler.googleapis.com --project="${PROJECT_ID}" >/dev/null
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:service-$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --condition=None >/dev/null
gcloud run services add-iam-policy-binding "itr-client-hq" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/run.invoker" >/dev/null

# Pass X-Cron-Secret header when env is bound. NOTE: `jobs create` uses
# `--headers`, `jobs update` uses `--update-headers` (different flag names).
CREATE_HEADERS_FLAG=()
UPDATE_HEADERS_FLAG=()
if [[ -n "${CRON_SHARED_SECRET:-}" ]]; then
  CREATE_HEADERS_FLAG=(--headers="X-Cron-Secret=${CRON_SHARED_SECRET}")
  UPDATE_HEADERS_FLAG=(--update-headers="X-Cron-Secret=${CRON_SHARED_SECRET}")
  echo "==> X-Cron-Secret header will be set on the job"
fi

if gcloud scheduler jobs describe "${JOB_NAME}" \
     --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> updating existing job ${JOB_NAME}"
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="0 */2 * * *" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=300s \
    "${UPDATE_HEADERS_FLAG[@]}"
else
  echo "==> creating new job ${JOB_NAME}"
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="0 */2 * * *" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=300s \
    --description="Deposit safety net: reconcile awaiting_deposit retreats against Stripe every 2h" \
    "${CREATE_HEADERS_FLAG[@]}"
fi

echo
echo "==> done. Manual fire:"
echo "    gcloud scheduler jobs run ${JOB_NAME} --location=${REGION} --project=${PROJECT_ID}"
