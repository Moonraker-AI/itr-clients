# ITR Client HQ

Client management system for [Intensive Therapy Retreats](https://www.intensivetherapyretreat.com).
Replaces the GoHighLevel intake, consent, and billing flow.

## Status
Pre-implementation. See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

## Stack (high level)
- GCP (Cloud Run, Cloud SQL, Cloud Storage, Secret Manager, Identity Platform)
- Hono on Node 20, Drizzle ORM
- Server-rendered templates with HTMX
- Stripe for payments, Gmail API for transactional email
- All HIPAA-covered services under Workspace + GCP BAAs

## Local dev
TBD — see [docs/DESIGN.md](docs/DESIGN.md) §11 for repo layout.
