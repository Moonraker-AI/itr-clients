# ITR Client HQ — Design Document

> Client management system for [Intensive Therapy Retreats](https://www.intensivetherapyretreat.com).
> Replaces the GoHighLevel-based intake, consent, and billing flow.

**Status:** M0–M9 shipped to dev (auth + payments + audit hardening); v0.8.4 in prod, next tag = v0.8.5
**Last updated:** May 5, 2026

---

## 1. Context

ITR runs intensive trauma-therapy retreats across 4 locations (Northampton MA, East Granby CT, Beacon NY, Auburn CA) with 6+ clinicians. Each clinician manages their own consultation pipeline — there is no central intake coordinator. Retreats are 0.5–5 days. Pricing varies by therapist.

### The current client journey (today, in GoHighLevel)

1. Prospect submits contact form on the marketing site, picks a therapist
2. Therapist holds a 20-min consultation call directly
3. If proceeding, therapist fills a hidden form on the WP site → consent package + payment link generated and emailed
4. Client signs consents → team + client notified, deposit reminder fires
5. Client pays deposit (typically 1 full day) → team notified, therapist confirms calendar dates
6. Retreat happens
7. Therapist submits post-retreat form with actual hours → final balance is auto-charged to the saved card on file
8. Cancellation/refund flows handled case-by-case at therapist discretion

### What's wrong with the current system

- GoHighLevel + Stripe Payment Links combo is mediocre at best
- Final balance currently requires a second client action — the goal is to charge the saved card automatically
- No HIPAA story for the consent/intake data (Workspace BAA helps for email but not the form data living in GHL)
- Each therapist juggles their own ad-hoc workflow

### Goals of this rebuild

- Therapist-driven pipeline with per-therapist views
- Consent package + payment link generation in one form submission
- Saved-payment-method flow so the final balance auto-charges
- ACH discount (3.0%) modeled correctly as **dual pricing**, not a surcharge — this is a legal distinction; ACH is the published price, CC is the same rate without the discount
- HIPAA-defensible end-to-end
- Small team-friendly admin UI; no client login

---

## 2. Stack & infrastructure

| Layer | Choice | HIPAA path |
|---|---|---|
| Hosting (everything) | **Cloud Run** on GCP, single service | GCP BAA |
| Web framework | **Hono** on Node 20 | n/a |
| UI approach | Server-rendered templates with HTMX for admin; minimal JS on public pages | n/a |
| Database | **Cloud SQL for Postgres** | GCP BAA |
| ORM | **Drizzle** with `drizzle-kit` for migrations | n/a |
| File storage | **Cloud Storage** (separate buckets for PHI vs static assets) | GCP BAA |
| Secrets | **Secret Manager** | GCP BAA |
| Auth | **Identity Platform** (Google sign-in restricted to @intensivetherapyretreat.com) | GCP BAA |
| Email | **Gmail API** via a `clients@intensivetherapyretreat.com` Workspace mailbox with domain-wide delegation | Workspace BAA (already executed) |
| Payments | **Stripe** Checkout Session + saved PaymentMethod, off-session PaymentIntent for final balance | Stripe BAA |
| PDFs | `@react-pdf/renderer` server-side, stored in Cloud Storage | n/a |
| Observability | **Cloud Logging + Cloud Monitoring** with PHI-redactor middleware | GCP BAA |
| CI/CD | **Cloud Build** triggered by GitHub push to `main` | n/a |
| Domain | `clients.intensivetherapyretreat.com` → Cloud Run via serverless NEG behind Google Cloud Load Balancer (for custom domain + Cloud Armor WAF) | n/a |

### Why this stack

- **One vendor for HIPAA.** Workspace + GCP both Google, both BAAs in the same admin context. No Cloudflare/Resend/Supabase scattering.
- **Gmail covers transactional email.** The existing Workspace BAA already covers Gmail-as-sending-infra. Cost: zero incremental beyond Workspace seats already paid.
- **Cloud Run scales to zero.** At ITR's volume (handfuls of state changes per day), idle cost is near-zero.
- **Drizzle over Prisma:** lighter, no codegen step that fights serverless cold starts, generates readable SQL for log review.
- **Server-rendered over SPA:** smaller PHI surface area, matches the Moonraker repo pattern, faster to ship.

### Stack pieces explicitly rejected

- **Resend for email** — does not sign BAAs at any tier
- **Cloudflare Pages/Workers for the API** — BAA is Enterprise-only and Workers/R2/D1 aren't currently in BAA scope
- **Supabase** — workable on Team plan + HIPAA add-on (~$800/mo combined), but redundant given GCP covers the same needs under one BAA
- **Stripe Payment Links** — can't cleanly save payment method for off-session reuse

---

## 3. GCP project layout

Two GCP projects under one organization. Names diverged from the original plan — `itr-prod-phi` and `itr-dev` were taken globally — so the actual project IDs are namespaced with `itr-clients-`:

```
itr-clients-prod-phi      project number 3904364585
                          ← all PHI lives here, BAA covers it
  - Cloud Run service: itr-client-hq
  - Cloud SQL:        itr-postgres-prod
  - Cloud Storage:    itr-consents-prod, itr-pdf-archive-prod
  - Secret Manager:   db-url, stripe-secret-key, stripe-webhook-secret,
                      gmail-service-account
  - Artifact Registry: itr (us-central1, Docker)
  - Workload Identity Federation pool (federates GitHub Actions for both
    environments; lives here because it is the prod project)
  - VPC + Private Service Connect to Cloud SQL (private IP only)
  - Org policy: deny non-HIPAA-eligible APIs

itr-clients-dev           project number 270821220116
                          ← dev + staging, NO real PHI ever
  - Cloud Run service: itr-client-hq
  - Cloud SQL:        itr-postgres-dev
  - Cloud Storage:    itr-consents-dev
  - Secret Manager:   db-url, stripe-* (test mode keys), gmail-service-account
  - Artifact Registry: itr (us-central1, Docker)
  - Same shape, synthetic data only
```

**Hard rule:** real client data only ever lands in `itr-clients-prod-phi`, after the GCP BAA is executed and the project's HIPAA flags are set. Dev is for synthetic data. CI gates enforce that a dev branch can never deploy to prod.

### Project bootstrap (one-time, manual)

This work has happened. The full provisioning record — project creation, BAA execution, CMEK, IAM bindings, WIF pool/provider, secrets, Artifact Registry, Cloud SQL — lives in [`GCP_BOOTSTRAP.md`](GCP_BOOTSTRAP.md). Outline of what was done:

1. Org created; two projects created under it
2. GCP BAA executed at org level
3. Billing enabled on both projects
4. Org policy denying non-HIPAA-eligible APIs on `itr-clients-prod-phi`
5. Required APIs enabled (Cloud Run, Cloud SQL Admin, Cloud Storage, Secret Manager, Cloud Build, Artifact Registry, IAM, Service Networking, KMS)
6. CMEK keys created in Cloud KMS and applied to Cloud SQL + Cloud Storage buckets
7. Service accounts created per env:
   - `itr-deployer-{dev,prod}@…` — CI deployer (Workload Identity-bound)
   - `itr-app@…` — Cloud Run runtime SA
8. Workload Identity Federation pool + GitHub provider configured (no long-lived JSON keys)
9. Cloud SQL instances on private IP only; reached via the Cloud SQL Node.js Connector at runtime
10. MFA enforced on all GCP and Workspace admin accounts

---

## 4. Pricing model

### Dual pricing, not surcharge

Per published rates: ACH is the standard price; credit card is the same rate without the 3.0% ACH discount. This phrasing matters — surcharges are not legal in all 50 states, but offering a discount for ACH is.

**Storage:** `pricing_config.ach_discount_pct = 0.030` (single editable row)

**Math:**
- ACH total = published rate × planned days
- CC total = ACH total ÷ (1 - 0.030) = ACH total × ~1.0309

### Per-therapist rates (from the public pricing page)

| Therapist | Full Day (ACH) | Half Day (ACH) | Location |
|---|---|---|---|
| Amy Shuman | $1,550 | $830 | Northampton, MA |
| Bambi Rattner | $1,550 | $830 | Northampton, MA |
| Jordan Hamilton | $2,000 | N/A | Auburn, CA |
| Nikki Gamache | $1,550 | $830 | Northampton, MA |
| Ross Hackerson | $2,400 | N/A | Northampton, MA |
| Vickie Alston | $1,550 | $830 | East Granby, CT |

### Snapshot rule

When a retreat is created, **the rates and `ach_discount_pct` are copied onto the retreat row.** Future changes to `pricing_config` or `therapists.default_*_cents` do not affect in-flight retreats. This is non-negotiable — it's the #1 way these systems get wrong over time.

### Sliding scale

Therapists set any price freely, no admin sign-off required. To keep visibility, the admin dashboard surfaces a "non-standard price" flag when the retreat's snapshotted rates differ from the therapist's defaults at creation time.

---

## 5. State machine

The spine of the entire system. One module (`src/lib/state-machine.ts`), one function per transition. Each transition validates source state, performs side effects (DB write, Stripe call, email send), writes an `audit_event`, and fires notifications. **Nothing else mutates `retreats.state`.**

```
draft
  → awaiting_consents
    → awaiting_deposit
      → scheduled
        → in_progress
          → awaiting_final_charge
            → completed
            ↘ final_charge_failed → (recovery via Customer Portal + cron retry) → completed
  ↘ cancelled (any time before completed)
```

### State definitions

| State | Meaning |
|---|---|
| `draft` | Retreat row created, before consent package is sent |
| `awaiting_consents` | Consent package emailed, client has not yet signed all required documents |
| `awaiting_deposit` | All consents signed, awaiting deposit payment |
| `scheduled` | Deposit paid, dates confirmed by therapist |
| `in_progress` | Cron flips this on `scheduled_start_date` |
| `awaiting_final_charge` | Therapist submitted completion form, off-session charge pending |
| `completed` | Final balance charged successfully |
| `final_charge_failed` | Off-session charge failed, in recovery |
| `cancelled` | Cancelled at any stage |

---

## 6. Stripe flow

### Deposit flow

1. Therapist creates client → server creates Stripe Customer with name + email (no PHI in metadata, just opaque `retreat_id`)
2. Consents signed → state `awaiting_deposit` → reminder email with checkout link
3. Client clicks `/c/[token]/checkout` → server creates a Stripe Checkout Session:
   ```
   mode: 'payment'
   customer: <stripe_customer_id>
   payment_intent_data: {
     setup_future_usage: 'off_session'
   }
   payment_method_types: ['card', 'us_bank_account']
   line_items: [...] // deposit only
   ```
   This charges the deposit AND saves the payment method for off-session reuse.
4. Webhook `checkout.session.completed` → save `default_payment_method_id` on `stripe_customers` → state `scheduled`

### Final balance flow

1. Therapist submits completion form with actual full days + half days
2. Server computes final amount from snapshotted rates: `total_actual_cents - deposit_cents`
3. Server creates a PaymentIntent off-session:
   ```
   amount: <balance>
   currency: 'usd'
   customer: <stripe_customer_id>
   payment_method: <saved_pm_id>
   off_session: true
   confirm: true
   ```
4. Success path → state `completed`, receipt email
5. Failure path branches:
   - `authentication_required` (3DS challenge needed) → email client a one-time hosted-confirmation link, state `final_charge_failed`
   - Other failures (insufficient funds, expired card, etc.) → state `final_charge_failed`, therapist + admin notified

### Failure recovery

- `Cloud Scheduler` cron retries `final_charge_failed` retreats at 24h and 72h intervals
- Smart retry: max 3 attempts, exponential backoff
- Client receives Customer Portal link for self-service card update
- After final retry exhausted → escalation email to admin + therapist for manual handling

### Cancellation / refund

- Case-by-case at therapist discretion (v1 default)
- Admin UI: "Cancel & Refund" button captures amount, reason, audit trail
- Stripe refund processed against the original PaymentIntent

---

## 7. Consent flow

### Templates are versioned and immutable once published

- Markdown files in `src/consents/`, named like `informed-consent-v3.md`
- Published versions have a row in `consent_templates` with `published_at` set
- When a retreat is created, the system snapshots **which template versions are required** at that moment
- Future template versions don't affect in-flight clients

### Signing

- Client lands on `/c/[token]/consents` (no auth, just the token)
- One page per required document, signed individually
- Per-document signature: typed legal name + checkbox + click
- Evidence captured per signature: IP address, user agent, timestamp, screen resolution, click coordinates
- On final signature, all `consent_signatures` rows written, PDFs generated server-side via `@react-pdf/renderer`, stored in Cloud Storage
- State transition to `awaiting_deposit` only when **all required documents are signed**

### PDF format

Each consent document generates one PDF with the signed name, evidence block, timestamp, and the original document body in full. Stored permanently in `gs://itr-consents-prod/<retreat_id>/<template_name>-v<n>-signed.pdf`.

---

## 8. Notifications

### Recipients (config-driven, not hardcoded)

`notification_recipients` table maps `event_type` → list of email addresses.

Default seed (migration 0003 swapped placeholder `team@` → real `support@`):
- `support@intensivetherapyretreat.com` (existing shared inbox) gets all admin-action emails
- Each therapist's email gets only **action-required** notifications (deposit paid → please confirm dates; charge failed → action needed)
- Therapists can see full state in the admin dashboard for non-actionable events
- Internal subject lines tagged with `[ret #abc12345]` (M9 tier-18) so admins can correlate mailbox alerts to the right retreat without opening the body — the tag is the first 8 chars of `retreat.id`, NOT PHI

### Email templates (React Email)

Client-facing:
- `client-consent-package` — first email after creation
- `client-consents-reminder` — 48hr nudge if unsigned
- `client-deposit-link` — after consents signed
- `client-deposit-receipt` — after deposit paid
- `client-dates-confirmed` — with `.ics`, what to bring, location info
- `client-final-receipt` — after retreat completed and final paid
- `client-payment-update-needed` — Customer Portal link, after charge failure
- `client-cancelled-refund` — after cancellation

Internal:
- `therapist-action-deposit-paid` — "X paid deposit, please confirm dates"
- `therapist-action-charge-failed` — "X final charge failed, action needed"
- `therapist-retreat-completed` — confirmation copy
- `admin-charge-failed-final` — escalation after retries exhausted

### Email content rules (HIPAA discipline)

- **No clinical detail in any email body, ever.** "Your retreat consent package is ready — click the secure link to view" is fine. "Your trauma intake form for PTSD treatment is ready" is not.
- Email body contains a link to the secure portal page; clinical detail lives behind the token.
- All sends go through one `notify(event_type, retreat_id)` function. Adding a new email = one config change.

### Calendar integration

`.ics` file generated server-side and emailed as attachment when therapist confirms dates. No two-way calendar sync in v1.

---

## 9. Schema (Drizzle)

All money in cents. All timestamps tz-aware. PHI flagged in comments.

```
therapists       id, full_name, slug, email, role ('admin'|'therapist'),
                 primary_location_id,
                 default_full_day_cents, default_half_day_cents (nullable),
                 active, created_at

locations        id, name, slug, address, city, state, active

pricing_config   single row:
                 ach_discount_pct (default 0.030),
                 default_deposit_days (default 1),
                 updated_by, updated_at

clients          id, first_name, last_name (PHI),
                 email, phone (PHI),
                 dob (PHI, optional),
                 emergency_contact_name, emergency_contact_phone,
                 state_of_residence,
                 notes (PHI, therapist-only),
                 created_by_therapist_id, created_at

retreats         id, client_id, therapist_id, location_id,
                 state (enum from §5),
                 planned_full_days, planned_half_days,
                 payment_method ('ach' | 'card'),
                 -- snapshotted at creation, never join to live config:
                 full_day_rate_cents, half_day_rate_cents,
                 ach_discount_pct,
                 total_planned_cents, deposit_cents,
                 -- filled at completion:
                 actual_full_days, actual_half_days,
                 total_actual_cents,
                 scheduled_start_date, scheduled_end_date,
                 client_token (unguessable URL slug, unique),
                 created_at, updated_at

consent_templates    id, name, version, body_markdown,
                     required_fields (jsonb), active, published_at

consent_signatures   id, retreat_id, template_id,
                     signed_name, signed_at,
                     ip_address, user_agent,
                     evidence_blob (jsonb),
                     pdf_storage_path

stripe_customers     client_id (unique FK), stripe_customer_id,
                     default_payment_method_id, payment_method_type

payments             id, retreat_id,
                     kind ('deposit' | 'final' | 'refund'),
                     stripe_payment_intent_id, stripe_charge_id,
                     amount_cents,
                     status ('pending' | 'succeeded' | 'failed' | 'refunded'),
                     failure_code, failure_message,
                     attempt_count, last_attempted_at,
                     created_at

audit_events         id, retreat_id,
                     actor_type ('therapist' | 'client' | 'system' | 'stripe'),
                     actor_id, event_type,
                     payload (jsonb), created_at

email_log            id, retreat_id, recipient,
                     template_id, gmail_message_id,
                     status ('sent' | 'delivered' | 'bounced' | 'complained'),
                     sent_at

notification_recipients   event_type → array of email addresses
```

---

## 10. URL / route map

```
clients.intensivetherapyretreat.com   (single Cloud Run service)

# Public client surfaces (tokenized, no auth)
/c/[token]                       status: "what's next"
/c/[token]/consents              consent signing flow
/c/[token]/checkout              Stripe Checkout redirect (deposit)
/c/[token]/checkout/success      post-deposit landing
/c/[token]/update-payment        Stripe Customer Portal redirect

# Internal team surfaces (auth deferred but RLS-equivalent enforced via app middleware)
/admin                           dashboard
/admin/clients/new               create client + retreat
/admin/clients/[id]              client detail + audit log
/admin/clients/[id]/complete     "Complete retreat" form
/admin/clients/[id]/refund       refund flow
/admin/therapists                admin only
/admin/pricing                   admin only

# API
POST /api/clients                       create client + retreat + send consent package
POST /api/consents/sign                 record signature, generate PDF, advance state
POST /api/checkout/create-session       Stripe Checkout Session for deposit
POST /api/checkout/portal-session       Stripe Customer Portal session
POST /api/retreats/[id]/complete        final hours + off-session charge
POST /api/retreats/[id]/refund          refund
POST /api/webhooks/stripe               handle Stripe events
POST /api/cron/retry-failed-charges     Cloud Scheduler → smart retry pass
POST /api/cron/state-transitions        Cloud Scheduler → flip in_progress on start_date, etc.
```

---

## 11. Repo skeleton

```
itr-clients/
├── src/
│   ├── server.ts                    # Hono app entry, served by Cloud Run
│   ├── routes/
│   │   ├── public.ts                # /c/[token]/*
│   │   ├── admin.ts                 # /admin/*
│   │   └── api/
│   │       ├── clients.ts
│   │       ├── consents.ts
│   │       ├── checkout.ts
│   │       ├── retreats.ts
│   │       ├── webhooks.ts
│   │       └── cron.ts
│   ├── db/
│   │   ├── schema.ts                # Drizzle schema
│   │   ├── client.ts                # Drizzle client w/ Cloud SQL connector
│   │   └── migrations/              # drizzle-kit output
│   ├── lib/
│   │   ├── state-machine.ts         # the spine
│   │   ├── pricing.ts               # all rate computation, snapshotted
│   │   ├── stripe.ts                # Stripe client + helpers
│   │   ├── gmail.ts                 # Gmail API send wrapper
│   │   ├── notifications.ts         # notify(event_type, retreat_id)
│   │   ├── pdf.ts                   # @react-pdf/renderer for consents
│   │   ├── tokens.ts                # client_token generation
│   │   ├── phi-redactor.ts          # log middleware
│   │   └── auth.ts                  # no-op in dev, Identity Platform later
│   ├── views/                       # server-rendered templates
│   │   ├── layout.tsx
│   │   ├── public/
│   │   └── admin/
│   ├── emails/                      # React Email templates
│   ├── consents/                    # versioned consent template markdown
│   └── styles/
│       └── tokens.css               # from ITR computed-style export
├── public/                          # static assets
├── tests/
│   ├── state-machine.test.ts
│   ├── pricing.test.ts
│   └── consent-flow.test.ts
├── infra/
│   ├── Dockerfile
│   ├── cloudbuild.yaml
│   ├── terraform/                   # optional: GCP project bootstrap
│   └── README.md                    # GCP setup checklist
├── docs/
│   ├── DESIGN.md                    # this file
│   └── GCP_BOOTSTRAP.md             # what's provisioned + how it was done
├── .env.example
├── drizzle.config.ts
├── package.json
└── README.md
```

---

## 12. Build milestones

Each milestone is independently shippable to dev. M5 is the gate to going live with real clients.

### M0 — GCP bootstrap & BAAs (DONE)

- Two GCP projects (`itr-clients-prod-phi`, `itr-clients-dev`)
- GCP BAA executed at org level
- Workspace BAA verified covers Gmail
- Stripe BAA in motion
- Cloud Run service `itr-client-hq` deployed to dev, hello-world reachable behind IAM auth
- Cloud SQL + Cloud Storage provisioned in both projects (private IP only)
- CI pipeline: push to `main` → deploy dev; tag `v*` → deploy prod (via WIF)
- Workload Identity Federation from GitHub Actions configured (no JSON keys)
- Drizzle scaffolding committed (lazy client + empty schema + migration runner). **Migrations are NOT yet wired into `infra/cloudbuild.yaml`** — deferred to M1, when we'll either use a Cloud Build private pool with VPC access or run migrations as a Cloud Run Job.
- Health endpoint: `/health` (NOT `/healthz` — Google Frontend reserves `/healthz` on `*.run.app` URLs and intercepts it before the container)

### M1 — Therapists, locations, pricing (1 day)

- Schema + seed: 6 therapists, 4 locations, pricing config
- Admin pricing page (read existing rates, edit `ach_discount_pct`)
- State-machine module skeleton with transition stubs
- PHI-redactor in place from day one

### M2 — Create client + consent package (3–4 days)

- `/admin/clients/new` form
- Client + retreat creation with snapshotted pricing
- `client_token` generation
- Consent template loader (versioned markdown files)
- Send consent package email via Gmail API
- Public `/c/[token]/consents` signing flow with evidence capture
- Server-side PDF generation via `@react-pdf/renderer`, stored in Cloud Storage
- State transition to `awaiting_deposit` on full signature

### M3 — Stripe checkout + saved methods (3 days)

- Stripe Customer creation hook
- Checkout Session in `payment` mode with `setup_future_usage: 'off_session'`
- Public `/c/[token]/checkout` redirects to Stripe-hosted Checkout
- Webhook handler for `checkout.session.completed`
- State transition to `scheduled`
- Deposit receipt email

### M4 — Confirm dates + .ics (1–2 days)

- Therapist date-confirmation form in admin
- `.ics` generation server-side, attached to confirmation email
- "What to bring" client email with location info

### M5 — Complete retreat + off-session charge (3 days, highest care)

- `/admin/clients/[id]/complete` form: actual full days + half days
- Compute `total_actual_cents` from snapshotted rates
- Off-session PaymentIntent: `confirm: true, off_session: true`
- Success → `completed` + receipt email
- `authentication_required` → email client a one-time confirmation link + state to `final_charge_failed`
- Other failures → `final_charge_failed` + therapist notification

### M6 — Failure recovery (2 days)

- Customer Portal session creation for client card update
- Cloud Scheduler cron at 24h/72h intervals
- Smart-retry logic (max 3 attempts, exponential backoff)
- Escalation email after final retry exhausted

### M7 — Admin polish (2 days)

- Dashboard list view by state, filter by therapist
- Audit log per client
- Refund flow (full or partial, reason captured)
- Pricing config edit history
- Email log viewer per retreat (debugging tool)

### M8 — Auth (1–2 days, deferred)

- Identity Platform integration
- `auth.ts` middleware flips from no-op to enforcing
- Two roles: admin sees all, therapist sees only own
- Workspace SSO via Identity Platform's Google provider — therapists log in with `@intensivetherapyretreat.com` accounts

**Total:** ~3 working weeks of focused dev for v1.

---

## 13. Pre-launch checklist

Before any real client data lands in `itr-prod-phi`:

- [ ] GCP BAA executed and saved
- [ ] Workspace BAA verified covers Gmail
- [ ] Stripe BAA executed
- [ ] `itr-prod-phi` flagged with org policy denying non-HIPAA-eligible APIs
- [ ] CMEK keys created in Cloud KMS, applied to Cloud SQL + Cloud Storage
- [ ] MFA enforced on all GCP and Workspace admin accounts
- [ ] PHI-redactor middleware verified (test that obvious PHI patterns get scrubbed from logs)
- [ ] Email templates reviewed: no clinical detail in any body, links only
- [ ] Stripe metadata audited: only opaque IDs, never names/emails
- [ ] Cancellation/refund policy documented somewhere clients can see
- [ ] Backup + point-in-time-recovery enabled on Cloud SQL
- [ ] Incident response plan written (who gets paged, breach notification timeline)
- [ ] Therapist email list provided + seeded into `notification_recipients`
- [ ] Production cutover plan from GoHighLevel (clean cutover; GHL keeps in-flight clients)

---

## 14. Open questions / future work

Not blocking v1, but worth deciding before v1.5:

- **Therapist licensing/jurisdiction enforcement** — should the system block creating a retreat for a client whose `state_of_residence` doesn't match the therapist's licensed states?
- **Sliding scale audit visibility** — surface "non-standard price" flag in admin even though no approval is required
- **Client-facing "what's next" page** at `/c/[token]` — useful UX or scope creep?
- **Two-way Google Calendar sync** — defer past v1
- **Migration from GoHighLevel for active in-flight clients** — clean cutover only for v1; if needed later, build an importer

---

## 15. Decisions log (for future-me)

| # | Decision | Rationale |
|---|---|---|
| 1 | GCP-only stack | One BAA, one vendor, Workspace+GCP same admin context |
| 2 | Cloud Run for everything (not split with Cloudflare Pages) | Simpler architecture, ITR's volume doesn't justify the split |
| 3 | Drizzle over Prisma/Kysely | Lightweight, no codegen issues on Cloud Run, good DX |
| 4 | Server-rendered + HTMX over SPA | Smaller PHI surface, matches Moonraker pattern, faster ship |
| 5 | Gmail API for transactional email | Covered by existing Workspace BAA, no incremental cost |
| 6 | Stripe Checkout Session with `setup_future_usage` | Cleanest off-session reuse path, vs Payment Element or Payment Links |
| 7 | Typed-name + checkbox e-sig with evidence block | Defensible without paying DocuSign tax |
| 8 | Clean cutover from GHL, no in-flight migration | Reduces v1 scope significantly |
| 9 | ACH discount, NOT CC surcharge (terminology) | Surcharges illegal in some states; discount framing is universally legal |
| 10 | Two roles: admin + therapist | Sufficient for current team size |
| 11 | Therapists set sliding-scale prices freely | No admin approval queue; trust-based |
| 12 | `.ics` file in email, no two-way calendar sync | Ships fast, real benefit; sync is v1.5+ |
| 13 | Smart retry + Customer Portal for charge failures | Best client UX while protecting recovery |
| 14 | Identity Platform (deferred) for auth | GCP-native, covered by GCP BAA, Workspace SSO option |
| 15 | Pricing snapshotted onto retreat at creation | Critical for in-flight retreat correctness over time |
| 16 | Single `notify()` function with config-driven recipients | Adding emails = config change, not code change |
| 17 | Stripe PHI rules anchored in §16 (this doc) and enforced in `src/lib/stripe.ts` | Single source of truth for the §1179 boundary; CONTRIBUTING.md checklist references it |

---

## 16. Stripe PHI rules (HIPAA §1179 boundary)

Stripe operates under HIPAA's §1179 payment-processing exemption. The exemption holds **only if PHI never enters Stripe systems.** Stripe is not under our BAA — they don't sign one for the §1179 path. Every Stripe field we populate must be assumed to be subject-access-requestable, dump-able, and retained beyond our control. Treat the integration as a one-way door: opaque IDs in, payment status out.

### What never goes into any Stripe field

- Diagnoses, conditions, treatment types
- Therapist-written narrative or intake notes
- Document/consent content
- Date-of-birth (use Stripe's identity verification flows if ever required, never raw DOB in metadata)
- State of residence beyond billing country/region
- Anything that, combined with the customer's name, would reveal clinical context

### Field-by-field rules

**`Customer` object**

| Field | Rule |
|---|---|
| `name` | First + last OK (standard payment data; covered by §1179) |
| `email` | OK |
| `phone` | OK (used for receipt SMS) |
| `description` | Set only to a generic constant — never a clinical descriptor. Allowed: `"ITR client"`. |
| `metadata.client_id` | Opaque UUID only |
| `metadata.retreat_id` | Opaque UUID only |
| `metadata.*` | Opaque IDs only — never include treatment context, location, therapist, dates, or any clinical detail |
| `address` | Skip unless billing chargeback flow demands it |

**`PaymentIntent` and `Checkout Session`**

| Field | Rule |
|---|---|
| `description` | Generic only — `"Retreat services"`, `"Retreat services - N days"`, `"Retreat deposit"`. Never include client name, condition, or treatment type. |
| `metadata` | Same opaque-ID rule as `Customer` |
| `statement_descriptor` / `statement_descriptor_suffix` | Generic merchant name. Never `"ITR Trauma Tx"` or any clinical hint |
| `receipt_email` | OK (this is the payment receipt path; client's email is already in §1179 scope) |

**`Refund` object**

| Field | Rule |
|---|---|
| `reason` | Use Stripe's enum values only (`requested_by_customer`, `duplicate`, `fraudulent`) |
| `metadata` | Same opaque-ID rule. Never put narrative reasoning about clinical or treatment context |

**Webhooks**

- All Stripe events return through our handler. PHI-relevant correlation is done by `metadata.retreat_id` lookup → DB.
- Webhook handlers MUST NOT log raw event bodies. The PHI-redactor middleware (M1+) is enforced on all `console.log`/error paths; webhook code is no exception.

### Enforcement

- **Single wrapper module: `src/lib/stripe.ts`.** All Stripe API calls go through it. Direct `stripe-node` imports outside this module are a bug; CI lint catches them (M3+).
- The wrapper:
  - Validates `description` against an allow-list of generic strings.
  - Rejects `metadata` values that look like emails, phone numbers, dates, or have length > 50 chars.
  - Rejects any metadata key not in a configured allow-list (`client_id`, `retreat_id`, `payment_kind`, etc.).
- The Stripe PHI checkpoint in [`CONTRIBUTING.md`](../CONTRIBUTING.md) is mandatory for every PR touching the wrapper or any Stripe call site.
- A periodic audit (M7+ admin tooling) lists all Stripe `Customer` + `PaymentIntent` records and flags any field that doesn't match these rules.

### If a violation is discovered

1. Stop. Do not deploy further changes that depend on the violating field.
2. Rotate any data that should not be in Stripe — typically by overwriting the field via API.
3. File an incident note (audit log entry) with the affected `retreat_id` and the field that leaked.
4. Update the wrapper validator to make the same class of leak impossible going forward.

---

*This document is the source of truth for ITR Client HQ design. Any decision change should update both the relevant section and the decisions log.*
