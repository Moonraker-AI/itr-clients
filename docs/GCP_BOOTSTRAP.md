# GCP Bootstrap

What's provisioned in GCP for ITR Client HQ, how it was done, and what's
deliberately deferred. This is the runbook a future maintainer can read
to either re-create the environment or operate on it.

> **Snapshot date:** 2026-04-30. Provisioning happened earlier the same
> day. If you're reading this much later, run the verification block at
> the bottom to confirm what's still true.

---

## 1. Projects

Two GCP projects, both under the Moonraker org:

| Project ID | Project number | Purpose |
|---|---|---|
| `itr-clients-prod-phi` | `3904364585` | All PHI lives here. Production. |
| `itr-clients-dev` | `270821220116` | Synthetic data only. Dev / staging. |

Both created `2026-04-30T09:45 UTC`. The `-clients-` infix exists because
`itr-prod-phi` and `itr-dev` were taken globally in the GCP project ID
namespace.

**Hard rule:** real client data only ever lands in
`itr-clients-prod-phi`. Dev gets synthetic data. The CI workflow enforces
this — `main` push deploys to dev only; only a `v*` tag deploys to prod.

---

## 2. BAAs and compliance posture

- **GCP BAA** — executed at the org level via Cloud Console
  (Security → Compliance → BAA).
- **Workspace BAA** — separate, already executed; covers Gmail-as-
  sending-infra (the `clients@` mailbox path).
- **Stripe BAA** — Stripe does not sign one for the §1179 path we use;
  see `docs/DESIGN.md §16` for the discipline rules that keep us inside
  the §1179 exemption.
- MFA is enforced on all GCP and Workspace admin accounts.
- Org policy denying non-HIPAA-eligible APIs is applied to
  `itr-clients-prod-phi` (Cloud Console → IAM → Organization Policies).

---

## 3. Enabled APIs (both projects)

The provisioned set, alphabetised:

```
artifactregistry         iam                       servicemanagement
cloudbuild               iamcredentials            servicenetworking
cloudkms                 logging                   serviceusage
cloudresourcemanager     monitoring                sqladmin
cloudtrace               oslogin                   sql-component
compute                  pubsub                    storage / -api / -component
containerregistry        run                       sts
gmail                    secretmanager             telemetry
```

Plus BigQuery + Dataform / Dataplex / Datastore which are enabled by
default; they're harmless and unused. Trim later if desired.

---

## 4. Cloud SQL

Both instances run **Postgres 16** in `us-central1` on **private IP only**
(`ipv4Enabled: false`). Reachable at runtime through the Cloud SQL
Node.js Connector library — see `src/db/client.ts`.

| | Dev | Prod |
|---|---|---|
| Instance | `itr-postgres-dev` | `itr-postgres-prod` |
| Tier | `db-f1-micro` | `db-custom-1-3840` (1 vCPU / 3.84 GB) |
| Disk | 10 GB | 20 GB |
| Private IP | `172.25.0.3` | `10.69.0.3` |
| CMEK | **Google-managed** (TODO: bind dev to a CMEK key for parity) | `cloudsql-key` (CMEK) |
| Backup | enabled, daily @ 04:00 UTC | enabled, daily @ 04:00 UTC |
| PITR (txlog) | 7 days | 7 days |
| Database | `itr_app` | `itr_app` |
| Users | `itr_app_user` (built-in), `postgres` | same |

App connects as `itr_app_user` (never `postgres` root). Password is
stored as the full connection string in Secret Manager → `db-url`.

### VPC + private path

Both projects use the auto-mode `default` VPC. Private Service Access
(PSA) peering is configured on each:

```
network:  default
range:    google-managed-services-default
service:  servicenetworking.googleapis.com
```

That peering is what lets Cloud SQL allocate a private IP and routes
the Cloud SQL Connector to it.

---

## 5. Cloud Storage

**Prod buckets** (in `itr-clients-prod-phi`, `us-central1`):
- `itr-consents-prod` — signed consent PDFs
- `itr-pdf-archive-prod` — long-term PDF archive (receipts, completed
  retreat docs)

**Dev buckets** (in `itr-clients-dev`, `us-central1`):
- `itr-consents-dev` — synthetic consents
- `itr-clients-dev_cloudbuild` — auto-created by Cloud Build for source
  staging (do not touch by hand)

**TODO (compliance gap):** The CMEK keys (`storage-key` in
`itr-keyring`) exist but are **not currently bound** to the prod
buckets. All buckets are using Google-managed encryption. Bind before
landing real PHI:

```
gcloud storage buckets update gs://itr-consents-prod \
  --default-encryption-key=projects/itr-clients-prod-phi/locations/us-central1/keyRings/itr-keyring/cryptoKeys/storage-key
gcloud storage buckets update gs://itr-pdf-archive-prod \
  --default-encryption-key=projects/itr-clients-prod-phi/locations/us-central1/keyRings/itr-keyring/cryptoKeys/storage-key
```

Also enable uniform bucket-level access + object versioning on the prod
buckets if not already (the introspection didn't surface a value).

---

## 6. KMS (CMEK keys)

**Prod keyring:** `projects/itr-clients-prod-phi/locations/us-central1/keyRings/itr-keyring`

| Key | Purpose | Rotation |
|---|---|---|
| `cloudsql-key` | Bound to `itr-postgres-prod` | 90 days (`7776000s`) |
| `secrets-key` | Intended for Secret Manager CMEK (TODO: bind) | 90 days |
| `storage-key` | Intended for prod GCS buckets (TODO: bind, see §5) | 90 days |

**Dev:** no keyring. Dev uses Google-managed encryption everywhere.
That's acceptable for synthetic data; bind dev to a CMEK key if you
want full parity with prod for migration testing.

---

## 7. Secret Manager

Same secret name scheme in both projects (different values):

| Secret | What |
|---|---|
| `db-url` | Full Postgres connection string for `itr_app_user`. The host portion is ignored at runtime; the Cloud SQL Connector overrides it. |
| `stripe-secret-key` | Stripe API key. Test-mode in dev, live in prod (set on or before M3). |
| `stripe-webhook-secret` | Stripe webhook signing secret (set on M3). |
| `gmail-service-account` | JSON for the Gmail-API service account with domain-wide delegation. |

All replication is currently default-`automatic` (multi-region). No
CMEK applied — `secrets-key` exists but isn't bound. **TODO: bind
prod secrets to `secrets-key` before real PHI lands.**

The runtime SA (`itr-app@`) has `roles/secretmanager.secretAccessor`
project-wide. Tighten to per-secret bindings in a later pass if you want.

---

## 8. Service accounts

### `itr-clients-dev`

| SA | Display name | Purpose |
|---|---|---|
| `itr-app@itr-clients-dev.iam.gserviceaccount.com` | ITR Client HQ runtime | Cloud Run runtime SA |
| `itr-deployer-dev@itr-clients-dev.iam.gserviceaccount.com` | ITR Client HQ deployer (dev) | CI deployer (Workload Identity-bound) |
| `270821220116-compute@developer.gserviceaccount.com` | Default compute service account | Auto-created. Unused. Remove or disable later. |

### `itr-clients-prod-phi`

| SA | Display name | Purpose |
|---|---|---|
| `itr-app@itr-clients-prod-phi.iam.gserviceaccount.com` | ITR Client HQ runtime | Cloud Run runtime SA |
| `itr-deployer-prod@itr-clients-prod-phi.iam.gserviceaccount.com` | ITR Client HQ deployer (prod) | CI deployer |
| `gmail-sender@itr-clients-prod-phi.iam.gserviceaccount.com` | Gmail API sender | Domain-wide-delegation SA used by Gmail API |
| `3904364585-compute@developer.gserviceaccount.com` | Default compute SA | Auto-created. Unused. |

### IAM bindings (current)

**Runtime SA `itr-app@…` (both projects):**
- `roles/cloudsql.client`
- `roles/secretmanager.secretAccessor`

Add `roles/storage.objectAdmin` on the relevant GCS buckets when M2 starts uploading consents/PDFs.

**Deployer SA `itr-deployer-dev@…` (dev):**
- `roles/artifactregistry.writer`
- `roles/cloudbuild.builds.editor`
- `roles/iam.serviceAccountUser`
- `roles/run.admin`
- `roles/serviceusage.serviceUsageConsumer` *(added 2026-04-30 to fix CI)*
- `roles/storage.admin` *(added 2026-04-30 to fix CI)*

**Deployer SA `itr-deployer-prod@…` (prod):**
- `roles/artifactregistry.writer`
- `roles/cloudbuild.builds.editor`
- `roles/iam.serviceAccountUser`
- `roles/run.admin`
- *missing:* `roles/serviceusage.serviceUsageConsumer`
- *missing:* `roles/storage.admin`

**TODO:** grant the missing two on prod before the first `v*` tag deploy. Same fix as dev:

```
SA=serviceAccount:itr-deployer-prod@itr-clients-prod-phi.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding itr-clients-prod-phi \
  --member="$SA" --role=roles/serviceusage.serviceUsageConsumer --condition=None
gcloud projects add-iam-policy-binding itr-clients-prod-phi \
  --member="$SA" --role=roles/storage.admin --condition=None
```

---

## 9. Workload Identity Federation (WIF)

The pool lives in **prod** (`itr-clients-prod-phi`, project number
`3904364585`). Both deployer SAs federate through it.

```
Pool      projects/3904364585/locations/global/workloadIdentityPools/github-pool
Provider  …/providers/github-provider
Issuer    https://token.actions.githubusercontent.com
Mapping   attribute.actor             = assertion.actor
          attribute.ref               = assertion.ref
          attribute.repository        = assertion.repository
          attribute.repository_owner  = assertion.repository_owner
          google.subject              = assertion.sub
```

Each deployer SA has `roles/iam.workloadIdentityUser` granted to the
narrowed principalSet:

```
principalSet://iam.googleapis.com/projects/3904364585/locations/global/workloadIdentityPools/github-pool/attribute.repository/Moonraker-AI/itr-clients
```

That principalSet locks WIF to this exact repo — a token from any other
GitHub repo cannot impersonate either deployer SA.

The full provider resource path is what gets stored in the GitHub repo
variable `GCP_WORKLOAD_IDENTITY_PROVIDER`.

---

## 10. Artifact Registry

| Project | Repo | Format | Region | Encryption |
|---|---|---|---|---|
| `itr-clients-dev` | `itr` | DOCKER | `us-central1` | Google-managed |
| `itr-clients-prod-phi` | `itr` | DOCKER | `us-central1` | Google-managed |

Image path used by the build:

```
us-central1-docker.pkg.dev/<project>/itr/itr-client-hq:<tag>
```

A bootstrap-era `itr-images` repo with one `hello:smoke` test image
existed in dev and was deleted on 2026-04-30.

---

## 11. Cloud Run

Service name: **`itr-client-hq`** in both projects.

Dev URL: `https://itr-client-hq-buejbopu5q-uc.a.run.app`
(IAM-gated; requires a Bearer identity token).

Configuration applied by `infra/cloudbuild.yaml`:

- min instances: 0 (scale-to-zero)
- max instances: 5
- 1 vCPU, 512 MiB
- concurrency: 80
- timeout: 60s
- ingress: all
- auth: `--no-allow-unauthenticated`
- runtime SA: `itr-app@…`
- env: `NODE_ENV=production`, `CLOUD_SQL_INSTANCE=<project>:us-central1:<sql-instance>`

**Note on health endpoints:** Google Frontend reserves `/healthz` on
`*.run.app` URLs and intercepts it before the container — the app
exposes `/health` as the canonical endpoint. `/healthz` is registered
as an alias for non-Cloud-Run environments.

---

## 12. GitHub Actions integration

### Required repository Variables (Settings → Secrets and variables → Actions → Variables)

| Name | Value |
|---|---|
| `GCP_PROJECT_ID_DEV` | `itr-clients-dev` |
| `GCP_PROJECT_ID_PROD` | `itr-clients-prod-phi` |
| `GCP_REGION` | `us-central1` |
| `GCP_DEPLOYER_SA_DEV` | `itr-deployer-dev@itr-clients-dev.iam.gserviceaccount.com` |
| `GCP_DEPLOYER_SA_PROD` | `itr-deployer-prod@itr-clients-prod-phi.iam.gserviceaccount.com` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | full resource path from §9 |

These are non-sensitive identifiers and are stored as Variables, not
Secrets. There are no long-lived JSON keys anywhere.

### Branch protection on `main`

- Required check: `deploy`
- Strict (must be up to date with base)
- Linear history required
- Force pushes blocked
- Branch deletion blocked
- Conversation resolution required

---

## 13. Known gaps / TODOs

These are tracked here rather than scattered through the doc:

- [ ] **Prod deployer SA** missing `serviceusage.serviceUsageConsumer` + `storage.admin` (§8). Block on first `v*` tag deploy until fixed.
- [ ] **CMEK on GCS buckets** (`storage-key`) not bound (§5). Block before real PHI lands in `itr-consents-prod`.
- [ ] **CMEK on Secret Manager** (`secrets-key`) not bound (§7). Block before real PHI lands.
- [ ] **CMEK on dev Cloud SQL** for parity (§4) — nice-to-have.
- [ ] **Migration runner** not yet wired into `infra/cloudbuild.yaml`. Decision deferred to M1: private Cloud Build pool with VPC access vs. Cloud Run Job.
- [ ] **PHI redactor middleware** not yet implemented (lands M1).
- [ ] **Org policy** denying non-HIPAA-eligible APIs on prod — verify enforcement in console; introspection didn't surface specific deny rules.
- [ ] **Unused default compute SAs** (both projects) — disable when convenient.

---

## 14. Verification block (run any time)

If you want to confirm what's described above is still true, the
following commands cover the essentials. They print only metadata, no
secret values.

```bash
# Projects exist with the expected numbers
gcloud projects list --filter='projectId:itr-clients-*' \
  --format='table(projectId,projectNumber)'

# Cloud SQL: private IP, CMEK on prod
for P in itr-clients-dev:itr-postgres-dev itr-clients-prod-phi:itr-postgres-prod; do
  PROJ=${P%%:*}; INST=${P##*:}
  gcloud sql instances describe $INST --project=$PROJ \
    --format='value(name,settings.ipConfiguration.ipv4Enabled,ipAddresses[0].type,diskEncryptionConfiguration.kmsKeyName)'
done

# Deployer SA roles match §8
for P in dev:itr-clients-dev:itr-deployer-dev prod:itr-clients-prod-phi:itr-deployer-prod; do
  ENV=${P%%:*}; PROJ=$(echo $P | cut -d: -f2); SA=$(echo $P | cut -d: -f3)@$(echo $P | cut -d: -f2).iam.gserviceaccount.com
  echo "=== $ENV ==="
  gcloud projects get-iam-policy $PROJ --flatten='bindings[].members' \
    --filter="bindings.members:$SA" --format='value(bindings.role)' | sort
done

# WIF principalSet still locked to this repo
gcloud iam service-accounts get-iam-policy \
  itr-deployer-dev@itr-clients-dev.iam.gserviceaccount.com \
  --project=itr-clients-dev --format='value(bindings)'
```
