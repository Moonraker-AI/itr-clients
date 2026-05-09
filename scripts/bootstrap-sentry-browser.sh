#!/usr/bin/env bash
#
# v0.21.0 — bootstrap browser-side Sentry on a project.
#
# Mirrors scripts/bootstrap-sentry.sh but for the BROWSER DSN. The two
# DSNs come from separate Sentry projects (one for the Node server, one
# for the browser SDK) so we can set per-project rate limits + alerting.
#
# Idempotent. Creates (or updates) the `sentry-browser-dsn` Secret
# Manager entry, binds the runtime SA to read it, and prints the
# substitution snippet to paste into the Cloud Build trigger.
#
# Usage:
#   SENTRY_BROWSER_DSN='https://...@oXXX.ingest.sentry.io/YYYY' \
#     scripts/bootstrap-sentry-browser.sh dev
#   SENTRY_BROWSER_DSN='...' scripts/bootstrap-sentry-browser.sh prod

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
    echo "usage: SENTRY_BROWSER_DSN=... $0 dev|prod" >&2
    exit 2
    ;;
esac

if [[ -z "${SENTRY_BROWSER_DSN:-}" ]]; then
  echo "SENTRY_BROWSER_DSN env var is required (paste the DSN from Sentry browser project settings)" >&2
  exit 2
fi

RUNTIME_SA="itr-app@${PROJECT_ID}.iam.gserviceaccount.com"
SECRET_NAME="sentry-browser-dsn"

echo "==> project=${PROJECT_ID}"
echo "==> runtime SA=${RUNTIME_SA}"

gcloud services enable secretmanager.googleapis.com --project="${PROJECT_ID}" >/dev/null

if gcloud secrets describe "${SECRET_NAME}" --project="${PROJECT_ID}" \
     >/dev/null 2>&1; then
  echo "==> secret ${SECRET_NAME} exists; adding new version"
  printf '%s' "${SENTRY_BROWSER_DSN}" | gcloud secrets versions add "${SECRET_NAME}" \
    --project="${PROJECT_ID}" \
    --data-file=- >/dev/null
else
  echo "==> creating secret ${SECRET_NAME}"
  printf '%s' "${SENTRY_BROWSER_DSN}" | gcloud secrets create "${SECRET_NAME}" \
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
    this substitution so the next deploy mounts SENTRY_BROWSER_DSN into
    Cloud Run:

      _SENTRY_BROWSER_SECRETS_PART = ,SENTRY_BROWSER_DSN=sentry-browser-dsn:latest

    (Note the leading comma — it joins onto the existing --set-secrets list.)
    Then re-run the most recent build to pick it up, or push a no-op commit.
EOF
