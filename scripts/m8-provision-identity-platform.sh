#!/usr/bin/env bash
#
# M8 — provision Identity Platform (Firebase Auth) in a target GCP project.
#
# Identity Platform setup is split between gcloud-friendly bits (enabling
# the API, granting IAM) and console-only bits (initializing the tenant,
# adding the Google sign-in provider, restricting the OAuth consent screen,
# authorizing the Cloud Run domain). This script does the gcloud half and
# prints the manual checklist for the console half.
#
# Idempotent: re-running is safe.
#
# Usage:
#   scripts/m8-provision-identity-platform.sh dev
#   scripts/m8-provision-identity-platform.sh prod
#
# Required env (or pass on CLI):
#   GCP_REGION            (e.g. us-central1)
#   ITR_DEV_PROJECT_ID    (only needed for `dev`)
#   ITR_PROD_PROJECT_ID   (only needed for `prod`)

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

RUNTIME_SA="itr-app@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> project=${PROJECT_ID}"
echo "==> service=${SERVICE_URL}"
echo "==> runtime SA=${RUNTIME_SA}"

# 1. Enable APIs. Identity Platform sits on top of identitytoolkit; the
#    Firebase Management API is needed to create/inspect the web app config.
echo "==> enabling APIs"
gcloud services enable \
  identitytoolkit.googleapis.com \
  firebase.googleapis.com \
  --project="${PROJECT_ID}"

# 2. Grant the runtime SA permission to verify ID tokens. The Identity
#    Platform admin SDK uses this to fetch the public JWK set; on Cloud Run
#    with default ADC it inherits the runtime SA, so the SA needs the
#    `roles/firebaseauth.viewer` role at minimum. This is idempotent.
echo "==> granting roles/firebaseauth.viewer to runtime SA"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/firebaseauth.viewer" \
  --condition=None \
  --quiet >/dev/null

cat <<EOF

==> gcloud half done. Manual console steps remaining:

1. Initialize Identity Platform (one-time per project):
   https://console.cloud.google.com/customer-identity?project=${PROJECT_ID}
   Click "Enable Identity Platform". Select "Tier 1 - Free".

2. Add Google sign-in provider:
   https://console.cloud.google.com/customer-identity/providers?project=${PROJECT_ID}
   - Add provider → Google
   - Web SDK config: leave defaults
   - Save

3. Restrict allowed sign-in domain to intensivetherapyretreat.com:
   https://console.cloud.google.com/customer-identity/settings?project=${PROJECT_ID}
   - Under "Authorized domains", add: intensivetherapyretreat.com
   - Also add the Cloud Run hostname: $(echo "${SERVICE_URL}" | sed -e 's|https://||')
   - (Custom domain hostname goes here too once wired.)

4. Register a Firebase web app to get the browser config:
   https://console.firebase.google.com/project/${PROJECT_ID}/settings/general
   - Add app → Web → nickname "itr-client-hq"
   - Copy the apiKey + authDomain values from the snippet shown.

5. Bind GitHub repo vars (Settings → Variables → Actions):
   - FIREBASE_API_KEY_${ENV_NAME^^}      = <apiKey from step 4>
   - FIREBASE_AUTH_DOMAIN_${ENV_NAME^^}  = <authDomain from step 4>
   - PUBLIC_BASE_URL_${ENV_NAME^^}       = ${SERVICE_URL}
   - AUTH_ENABLED_${ENV_NAME^^}          = 1

6. Re-deploy: push a no-op commit to main (dev) or tag a v* (prod).
   Watch logs: server should refuse startup if PUBLIC_BASE_URL is unset
   when AUTH_ENABLED=1 (M9 fix #45 tripwire). If it boots, sign-in is live.

7. Smoke test:
   - Open ${SERVICE_URL}/login
   - Sign in with a @intensivetherapyretreat.com Google account
   - Confirm /admin/dashboard loads with that account in the session
EOF
