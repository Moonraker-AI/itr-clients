#!/usr/bin/env bash
#
# v0.22.0 — create the Cloud Scheduler job that POSTs
# /api/cron/weekly-digest every Sunday at 07:00 ET. Idempotent.
#
# Mirrors scripts/m6-create-retry-scheduler.sh + m12-...
#
# Pre-reqs (already met by the m4 script on first run):
#   - cloudscheduler.googleapis.com enabled
#   - Scheduler service agent has tokenCreator on the runtime SA
#   - Runtime SA has roles/run.invoker on itr-client-hq
#
# Usage:
#   scripts/m22-create-weekly-digest-scheduler.sh dev
#   scripts/m22-create-weekly-digest-scheduler.sh prod
#
# Per-client reminders are sent ONLY to retreats currently in
# `awaiting_consents` or `awaiting_deposit`. The admin rollup goes to
# bambi@ + chris@ + support@ unless WEEKLY_ROLLUP_RECIPIENTS env is set
# on the Cloud Run service to override (comma-separated).

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
JOB_NAME="itr-weekly-digest"
TARGET_URL="${SERVICE_URL}/api/cron/weekly-digest"

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
    --schedule="0 7 * * 0" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=300s \
    "${HEADERS_FLAG[@]}"
else
  echo "==> creating new job ${JOB_NAME}"
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="0 7 * * 0" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=300s \
    --description="v0.22.0 cron: per-client reminders + admin rollup, Sunday 07:00 ET" \
    "${HEADERS_FLAG[@]}"
fi

echo
echo "==> done. Manual fire:"
echo "    gcloud scheduler jobs run ${JOB_NAME} --location=${REGION} --project=${PROJECT_ID}"
