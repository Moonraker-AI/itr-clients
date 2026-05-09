#!/usr/bin/env bash
#
# v0.14.0 — bootstrap Sentry on a project.
#
# Idempotent. Creates (or updates) the `sentry-dsn` Secret Manager entry,
# binds the runtime SA to read it, and prints the substitution snippet to
# paste into the Cloud Build trigger.
#
# Usage:
#   SENTRY_DSN='https://...@oXXX.ingest.sentry.io/YYYY' \
#     scripts/bootstrap-sentry.sh dev
#   SENTRY_DSN='...' scripts/bootstrap-sentry.sh prod
#
# After running, manually edit the Cloud Build trigger and add the
# substitution this script prints at the end:
#   _SENTRY_SECRETS_PART = ,SENTRY_DSN=sentry-dsn:latest

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
    echo "usage: SENTRY_DSN=... $0 dev|prod" >&2
    exit 2
    ;;
esac

if [[ -z "${SENTRY_DSN:-}" ]]; then
  echo "SENTRY_DSN env var is required (paste the DSN from sentry.io project settings)" >&2
  exit 2
fi

RUNTIME_SA="itr-app@${PROJECT_ID}.iam.gserviceaccount.com"
SECRET_NAME="sentry-dsn"

echo "==> project=${PROJECT_ID}"
echo "==> runtime SA=${RUNTIME_SA}"

gcloud services enable secretmanager.googleapis.com --project="${PROJECT_ID}" >/dev/null

if gcloud secrets describe "${SECRET_NAME}" --project="${PROJECT_ID}" \
     >/dev/null 2>&1; then
  echo "==> secret ${SECRET_NAME} exists; adding new version"
  printf '%s' "${SENTRY_DSN}" | gcloud secrets versions add "${SECRET_NAME}" \
    --project="${PROJECT_ID}" \
    --data-file=- >/dev/null
else
  echo "==> creating secret ${SECRET_NAME}"
  printf '%s' "${SENTRY_DSN}" | gcloud secrets create "${SECRET_NAME}" \
    --project="${PROJECT_ID}" \
    --replication-policy=automatic \
    --data-file=- >/dev/null
fi

echo "==> granting secretAccessor to ${RUNTIME_SA}"
gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

cat <<EOF

==> done. Last step: edit the Cloud Build trigger for ${PROJECT_ID} and add
    this substitution so the next deploy mounts SENTRY_DSN into Cloud Run:

      _SENTRY_SECRETS_PART = ,SENTRY_DSN=sentry-dsn:latest

    (Note the leading comma — it joins onto the existing --set-secrets list.)
    Then re-run the most recent build to pick it up, or push a no-op commit.
EOF
