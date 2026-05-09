#!/usr/bin/env bash
#
# v0.17.0 — fire the itr-smoke-seed Cloud Run Job once.
#
# The Job is deployed (upserted) on every Cloud Build run via the
# smoke-seed-deploy step in infra/cloudbuild.yaml. It is NEVER
# auto-executed — only this helper (or an equivalent ad-hoc gcloud
# command) runs it, so we don't accumulate one smoke client per deploy.
#
# Usage:
#   bash scripts/run-smoke-seed.sh dev
#   bash scripts/run-smoke-seed.sh prod
#
# After completion, the Job's stdout (visible in Cloud Logging or via
# `gcloud run jobs executions describe ...`) prints the Public URL +
# Admin URL for the freshly-created smoke retreat. Use the Public URL
# to walk the consent flow in a browser; use the Admin URL to inspect
# state from the staff side.
#
# Cleanup is manual — cancel the retreat via the admin UI when you're
# done, or delete the row via SQL. Re-running just creates another.

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

REGION="${GCP_REGION:-us-central1}"
JOB_NAME="itr-smoke-seed"

echo "==> project=${PROJECT_ID} region=${REGION} job=${JOB_NAME}"
echo "==> firing Job (waiting for completion)..."

gcloud run jobs execute "${JOB_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --wait

echo
echo "==> Job complete. Stdout prints the Public + Admin URLs."
echo "    View:"
echo "      gcloud run jobs executions list --job=${JOB_NAME} \\"
echo "        --project=${PROJECT_ID} --region=${REGION} --limit=1"
echo "    Tail logs:"
echo "      gcloud logging read 'resource.type=\"cloud_run_job\" \\"
echo "        AND resource.labels.job_name=\"${JOB_NAME}\"' \\"
echo "        --project=${PROJECT_ID} --limit=20 --format='value(textPayload)'"
