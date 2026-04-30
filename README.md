# ITR Client HQ

Client management system for [Intensive Therapy Retreats](https://www.intensivetherapyretreat.com).

Replaces the GoHighLevel-based intake → consent → deposit → retreat →
final-charge pipeline. HIPAA-covered: PHI lives in `itr-clients-prod-phi`,
never anywhere else.

## Docs

- [`docs/DESIGN.md`](docs/DESIGN.md) — source of truth: architecture,
  schema, state machine, Stripe discipline, decisions log.
- [`docs/GCP_BOOTSTRAP.md`](docs/GCP_BOOTSTRAP.md) — how the GCP infra
  was provisioned.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow + the HIPAA non-
  negotiables.

## Stack

Hono on Node 20 → Cloud Run → Cloud SQL Postgres 16 (Drizzle).
Server-rendered + HTMX for admin. Stripe under §1179 exemption.
Gmail API via Workspace BAA. CI/CD: GitHub Actions → WIF → Cloud
Build → Cloud Run.

## Deploy

- Push to `main` → dev (`itr-clients-dev`)
- Tag `vX.Y.Z` on `main` → prod (`itr-clients-prod-phi`)

Cloud Run service: `itr-client-hq` (in both environments).

## Repo layout

```
src/
  server.ts           Hono app entry
  db/
    client.ts         Cloud SQL Connector + drizzle
    schema.ts         Drizzle schema
    migrate.ts        standalone migration runner
    migrations/       drizzle-kit output
  lib/                state machine, Stripe wrapper, redactor (M1+)
  routes/             admin + public routes (M1+)
infra/
  Dockerfile          multi-stage, non-root
  cloudbuild.yaml     build → deploy (migrations added M1)
.github/
  workflows/deploy.yml
  CODEOWNERS
docs/
  DESIGN.md
  GCP_BOOTSTRAP.md
```
