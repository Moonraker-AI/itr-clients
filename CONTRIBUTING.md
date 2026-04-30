# Contributing to ITR Client HQ

This project handles PHI for a HIPAA-covered practice. Read this once
before sending a PR.

## The non-negotiables

1. **No PHI in Stripe.** Stripe operates under HIPAA's §1179 payment-
   processing exemption. The exemption holds *only if PHI never enters
   their systems.* See `docs/DESIGN.md §16` for the field-by-field
   rules (and §6 for the surrounding payment flow). Every PR that
   touches Stripe code gets the discipline checklist below.

2. **No PHI in logs.** The redactor middleware (M1+) runs on all log
   output. Until then, never `console.log(req.body)` or dump client
   objects directly — log structural fields only.

3. **No secrets in the repo.** Not in code, not in committed `.env`
   files, not in CI vars. Secret Manager or `.env.local` (gitignored)
   only. The Gmail SA JSON was a one-time, justified exception, handled
   via Secret Manager from the start, never on disk.

4. **`retreats.state` mutates only via the state machine.** One module,
   one function per transition. Anywhere else writes that column, it's
   a bug. See `docs/DESIGN.md §5`.

5. **Pricing snapshots on retreat creation.** Never join to live pricing
   config to compute a total. See `docs/DESIGN.md §4`.

6. **ACH discount, never CC surcharge.** "Save 3% with ACH" in copy;
   `ach_discount_pct` in code.

7. **Real client data lives only in `itr-clients-prod-phi`.** Dev gets
   synthetic data: "Test Client 47", emails at `@example.com` or your
   own controlled addresses.

## Stripe PHI checkpoint

Touching `src/lib/stripe.ts` or anywhere that constructs a Stripe API
call? Confirm in the PR description:

- [ ] No diagnoses, conditions, or treatment types in any Stripe field
- [ ] `description` is generic ("Retreat services", "Retreat services -
      N days")
- [ ] `metadata` keys are opaque IDs only (UUIDs, not human-readable
      treatment context)
- [ ] No client narrative, intake notes, or therapist-written text
      reaches Stripe

## Workflow

- Branch from `main` as `kind/short-desc` (`feat/consent-package`,
  `fix/webhook-retry`).
- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
  `test:`. "fix bug" doesn't pass review.
- Open a PR. CI must be green. Solo-dev rule: you self-review; the
  build-must-pass gate catches accidents.
- Squash-merge to `main`. Tag `vX.Y.Z` to deploy prod.

## Local dev

```bash
nvm use 20
npm install

# In another terminal — Cloud SQL Auth Proxy against dev
cloud-sql-proxy itr-clients-dev:us-central1:itr-postgres-dev --port 5432

cp .env.example .env.local  # fill in the real DB password
npm run dev
```

`http://localhost:8080/healthz` returns `{ "ok": true, ... }`.

### Migrations (local only in M0)

Migrations are not yet wired into `infra/cloudbuild.yaml` — that lands
at M1. For now, generate and apply them locally:

```bash
# 1. Start the Cloud SQL Auth Proxy (see above) and set DEV_DB_URL +
#    LOCAL_DB_URL in .env.local.

# 2. Generate any pending migration from src/db/schema.ts. For an empty
#    schema this may produce no output file — that's fine.
npm run db:generate

# 3. Apply migrations to dev. This also creates the drizzle_migrations
#    tracking table on first run.
npm run db:migrate
```

## What needs a DESIGN.md update

- New top-level module
- New external dependency on a non-HIPAA-eligible service
- Schema changes to PHI-bearing tables
- Any change to state-machine transitions
- Stripe integration changes
