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
# Two IAM grants are needed (both idempotent below):
#   1. Scheduler service agent must mint OIDC tokens for the runtime SA
#      → `roles/iam.serviceAccountTokenCreator` on the runtime SA.
#   2. The runtime SA itself must be allowed to invoke the Cloud Run
#      service it targets → `roles/run.invoker` on `itr-client-hq`.
#      (Cloud Build deploys do NOT auto-grant invoker to the runtime SA.)

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

# Enable required APIs. Idempotent. The Scheduler service agent
# (service-<project-num>@gcp-sa-cloudscheduler...) is auto-provisioned
# the first time the API is enabled — its existence is required by the
# tokenCreator binding below.
gcloud services enable cloudscheduler.googleapis.com --project="${PROJECT_ID}" >/dev/null
# Give the service-agent provisioning a moment to land.
sleep 5

# Allow Scheduler to mint OIDC tokens for the runtime SA. Idempotent.
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:service-$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --condition=None >/dev/null

# Allow the runtime SA to invoke the main Cloud Run service. The minted
# OIDC token authenticates as the runtime SA; Cloud Run's IAM gate then
# checks that principal for `roles/run.invoker`. Idempotent.
gcloud run services add-iam-policy-binding "itr-client-hq" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/run.invoker" >/dev/null

# M9 fix #23: when CRON_SHARED_SECRET is exported, additionally pass
# X-Cron-Secret as a header on every Scheduler-fired POST. The Cloud
# Run service refuses cron requests without it once the env is bound
# in prod. The Scheduler API accepts repeated `--update-headers` flags
# (one per header).
HEADERS_FLAG=()
if [[ -n "${CRON_SHARED_SECRET:-}" ]]; then
  HEADERS_FLAG=(--update-headers="X-Cron-Secret=${CRON_SHARED_SECRET}")
  echo "==> X-Cron-Secret header will be set on the job"
fi

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
    --attempt-deadline=120s \
    "${HEADERS_FLAG[@]}"
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
    --description="M4 cron: scheduled -> in_progress on scheduled_start_date" \
    "${HEADERS_FLAG[@]}"
fi

echo
echo "==> done. Manual fire:"
echo "    gcloud scheduler jobs run ${JOB_NAME} --location=${REGION} --project=${PROJECT_ID}"
echo
echo "==> recent runs:"
gcloud scheduler jobs describe "${JOB_NAME}" \
  --location="${REGION}" --project="${PROJECT_ID}" \
  --format='value(state, lastAttemptTime, status.code)'
