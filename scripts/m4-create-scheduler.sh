#!/usr/bin/env bash
#
# M4 — create the Cloud Scheduler job that POSTs /api/cron/state-transitions
# nightly. Authn is OIDC: Scheduler signs a token addressed at the runtime
# SA; the Cloud Run IAM gate verifies it at the GFE before our app sees it.
#
# Idempotent: re-running with the same job name updates the existing job.
#
# Usage:
#   scripts/m4-create-scheduler.sh dev
#   scripts/m4-create-scheduler.sh prod
#
# Required env (or pass on CLI):
#   GCP_REGION            (e.g. us-central1)
#   ITR_DEV_PROJECT_ID    (only needed for `dev`)
#   ITR_PROD_PROJECT_ID   (only needed for `prod`)
#
# The runtime SA `itr-app@$PROJECT.iam.gserviceaccount.com` already has
# `roles/run.invoker` on the main service via Cloud Build deploy. Scheduler
# additionally needs `roles/iam.serviceAccountTokenCreator` on itself
# (granted once below if missing — safe to re-run).

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
JOB_NAME="itr-state-transitions"
TARGET_URL="${SERVICE_URL}/api/cron/state-transitions"

echo "==> project=${PROJECT_ID} region=${REGION}"
echo "==> target=${TARGET_URL}"
echo "==> oidc SA=${RUNTIME_SA}"

# Allow Scheduler to mint OIDC tokens for the runtime SA. Idempotent.
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:service-$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --condition=None >/dev/null

# Create or update the job. Cloud Scheduler doesn't have a single
# `create-or-update`; use describe→update / create accordingly.
if gcloud scheduler jobs describe "${JOB_NAME}" \
     --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> updating existing job ${JOB_NAME}"
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="5 6 * * *" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=120s
else
  echo "==> creating new job ${JOB_NAME}"
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="5 6 * * *" \
    --time-zone="America/New_York" \
    --uri="${TARGET_URL}" \
    --http-method=POST \
    --oidc-service-account-email="${RUNTIME_SA}" \
    --oidc-token-audience="${SERVICE_URL}" \
    --attempt-deadline=120s \
    --description="M4 cron: scheduled -> in_progress on scheduled_start_date"
fi

echo
echo "==> done. Manual fire:"
echo "    gcloud scheduler jobs run ${JOB_NAME} --location=${REGION} --project=${PROJECT_ID}"
echo
echo "==> recent runs:"
gcloud scheduler jobs describe "${JOB_NAME}" \
  --location="${REGION}" --project="${PROJECT_ID}" \
  --format='value(state, lastAttemptTime, status.code)'
