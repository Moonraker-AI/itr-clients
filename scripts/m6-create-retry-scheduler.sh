#!/usr/bin/env bash
#
# M6 — create the Cloud Scheduler job that POSTs /api/cron/retry-failed-charges
# daily. Mirrors `m4-create-scheduler.sh`. Idempotent.
#
# Pre-reqs already met by m4-create-scheduler.sh on first run:
#   - cloudscheduler.googleapis.com enabled
#   - Scheduler service agent has tokenCreator on the runtime SA
#   - Runtime SA has `roles/run.invoker` on `itr-client-hq`
# This script re-asserts those bindings idempotently in case it's run
# standalone in a fresh project.
#
# Usage:
#   scripts/m6-create-retry-scheduler.sh dev
#   scripts/m6-create-retry-scheduler.sh prod

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
JOB_NAME="itr-retry-failed-charges"
TARGET_URL="${SERVICE_URL}/api/cron/retry-failed-charges"

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

if gcloud scheduler jobs describe "${JOB_NAME}" \
     --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> updating existing job ${JOB_NAME}"
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="30 6 * * *" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=300s
else
  echo "==> creating new job ${JOB_NAME}"
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="30 6 * * *" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=300s \
    --description="M6 cron: retry final_charge_failed retreats with smart backoff (24h, 72h)"
fi

echo
echo "==> done. Manual fire:"
echo "    gcloud scheduler jobs run ${JOB_NAME} --location=${REGION} --project=${PROJECT_ID}"
