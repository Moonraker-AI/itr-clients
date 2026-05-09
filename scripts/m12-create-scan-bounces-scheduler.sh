#!/usr/bin/env bash
#
# v0.12.0 — create the Cloud Scheduler job that POSTs /api/cron/scan-bounces
# every 30 minutes. Mirrors `m6-create-retry-scheduler.sh`. Idempotent.
#
# Pre-reqs:
#   - Workspace DWD entry for the bounce-scan SA includes scope
#     `https://www.googleapis.com/auth/gmail.readonly`. Without this, the
#     cron returns 200 but listBounces() fails with `Insufficient
#     Permission`. See docs/bounce-tracking.md "Post-merge activation".
#   - cloudscheduler.googleapis.com enabled (m4 script handles this).
#   - Scheduler service agent has tokenCreator on the runtime SA (m4 too).
#
# Usage:
#   scripts/m12-create-scan-bounces-scheduler.sh dev
#   scripts/m12-create-scan-bounces-scheduler.sh prod

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
JOB_NAME="itr-scan-bounces"
TARGET_URL="${SERVICE_URL}/api/cron/scan-bounces"

echo "==> project=${PROJECT_ID} region=${REGION}"
echo "==> target=${TARGET_URL}"
echo "==> oidc SA=${RUNTIME_SA}"

# Idempotent re-asserts (no-op once m4 ran in fresh project).
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

HEADERS_FLAG=()
if [[ -n "${CRON_SHARED_SECRET:-}" ]]; then
  HEADERS_FLAG=(--update-headers="X-Cron-Secret=${CRON_SHARED_SECRET}")
  echo "==> X-Cron-Secret header will be set on the job"
fi

if gcloud scheduler jobs describe "${JOB_NAME}" \
     --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> updating existing job ${JOB_NAME}"
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="*/30 * * * *" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=120s \
    "${HEADERS_FLAG[@]}"
else
  echo "==> creating new job ${JOB_NAME}"
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="*/30 * * * *" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=120s \
    --description="v0.12.0 cron: scan inbound DSN messages, flip matched email_log rows to bounced" \
    "${HEADERS_FLAG[@]}"
fi

echo
echo "==> done. Manual fire:"
echo "    gcloud scheduler jobs run ${JOB_NAME} --location=${REGION} --project=${PROJECT_ID}"
