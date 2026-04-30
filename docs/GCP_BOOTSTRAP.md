# GCP Bootstrap

> **Status:** Stub. Provisioning is complete; full writeup pending.
>
> This file will document the one-time GCP setup that produced the dev
> and prod projects, Cloud SQL instances, Cloud Storage buckets, KMS
> keys, IAM bindings, Workload Identity Federation pools, and Secret
> Manager entries that the application repo depends on.

## What's already provisioned

- **GCP projects**
  - `itr-clients-prod-phi` (project number `3904364585`) — all PHI lives
    here; covered by the GCP BAA. Contains:
    - Cloud Run service: `itr-client-hq`
    - Cloud SQL: `itr-postgres-prod`
    - Cloud Storage: `itr-consents-prod`, `itr-pdf-archive-prod`
    - Secret Manager: Stripe keys, Gmail SA, DB URL
  - `itr-clients-dev` (project number `270821220116`) — synthetic data
    only; same shape as prod.
    - Cloud SQL: `itr-postgres-dev`
    - same buckets/secrets prefixed with `-dev`

- **Workload Identity Federation** — bound to GitHub Actions for the
  `Moonraker-AI/itr-clients` repo. WIF provider URL is stored in the
  `GCP_WORKLOAD_IDENTITY_PROVIDER` repo variable.

- **Service accounts**
  - `itr-app@itr-clients-{dev,prod-phi}.iam.gserviceaccount.com` — Cloud
    Run runtime SA. Has `roles/cloudsql.client`,
    `roles/secretmanager.secretAccessor`, `roles/storage.objectAdmin`
    on the relevant buckets.
  - Deployer SAs (per env) — referenced by the workflow as
    `GCP_DEPLOYER_SA_DEV` / `GCP_DEPLOYER_SA_PROD` repo variables.

- **Artifact Registry** — `itr` repo in `us-central1` in both projects.

- **Secrets in Secret Manager** (per project)
  - `db-url` — full Postgres connection string for `itr_app_user`
    (`postgres://itr_app_user:PASS@/itr`). The host portion is ignored
    at runtime; the Cloud SQL Connector library overrides it.
  - `stripe-secret-key`, `stripe-webhook-secret` (M3+)
  - `gmail-sa` (M2+)

## Required GitHub repo variables

Set under Settings → Secrets and variables → Actions → Variables:

| Variable | Value |
|---|---|
| `GCP_PROJECT_ID_DEV` | `itr-clients-dev` |
| `GCP_PROJECT_ID_PROD` | `itr-clients-prod-phi` |
| `GCP_REGION` | `us-central1` |
| `GCP_DEPLOYER_SA_DEV` | full SA email for the dev deployer |
| `GCP_DEPLOYER_SA_PROD` | full SA email for the prod deployer |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | full WIF provider resource path |

## TODO

- Reconstruct the actual provisioning commands (Terraform vs `gcloud`
  one-shots) from the kickoff session notes.
- Document KMS key ring + CMEK assignments per bucket and Cloud SQL
  instance.
- Document private VPC, peered services range, and the private-IP-only
  posture on Cloud SQL.
- Document Identity Platform tenant (deferred until M8).
