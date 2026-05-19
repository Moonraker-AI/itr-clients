#!/usr/bin/env bash
#
# Add/update the Cloud Logging sink exclusion that keeps bearer-token client
# portal URLs (/c/<token>/...) out of the default log bucket. Cloud Run request
# logs record full request URLs by default; for this app those URLs are live
# credentials.
#
# Usage:
#   scripts/create-token-log-exclusion.sh prod
#   scripts/create-token-log-exclusion.sh dev

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

SINK_NAME="_Default"
EXCLUSION_NAME="exclude-client-token-request-urls"
DESCRIPTION="Exclude Cloud Run request logs containing /c/<client_token> bearer URLs"
FILTER='resource.type="cloud_run_revision" AND resource.labels.service_name="itr-client-hq" AND log_id("run.googleapis.com/requests") AND httpRequest.requestUrl =~ "/c/[A-Za-z0-9_-]{32}"'

echo "==> project=${PROJECT_ID}"
echo "==> sink=${SINK_NAME}"
echo "==> exclusion=${EXCLUSION_NAME}"

if gcloud logging sinks describe "${SINK_NAME}" \
  --project="${PROJECT_ID}" \
  --format=json | rg -q "\"name\": \"${EXCLUSION_NAME}\""; then
  echo "==> updating existing exclusion"
  gcloud logging sinks update "${SINK_NAME}" \
    --project="${PROJECT_ID}" \
    --update-exclusion="name=${EXCLUSION_NAME},description=${DESCRIPTION},filter=${FILTER}"
else
  echo "==> adding exclusion"
  gcloud logging sinks update "${SINK_NAME}" \
    --project="${PROJECT_ID}" \
    --add-exclusion="name=${EXCLUSION_NAME},description=${DESCRIPTION},filter=${FILTER}"
fi

echo "==> done"
