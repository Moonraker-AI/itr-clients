# Client journey — end-to-end sequence

Covers the happy path plus failure-recovery branches. State labels match
`lib/state-machine.ts`. URLs prefixed with `/c/<token>` are token-gated
public surfaces; `/admin/*` are session-gated.

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Admin (therapist)
    actor Client as Client
    participant App as Hono app
    participant DB as Postgres
    participant Stripe
    participant Gmail
    participant Cron

    %% ── Onboarding ───────────────────────────────────────────
    Admin->>App: POST /admin/clients/new
    App->>DB: insert clients + retreats (state=draft)
    App->>App: transitions.sendConsentPackage
    App->>DB: state → awaiting_consents
    App->>Gmail: send consent_package email
    Gmail-->>Client: "Sign your consents"

    %% ── Consents ─────────────────────────────────────────────
    Client->>App: GET /c/:token
    App->>DB: load required + signed
    App-->>Client: status page (next: sign X)
    loop each required template
        Client->>App: GET /c/:token/consents
        App-->>Client: render template + signature canvas
        Client->>App: POST /c/:token/consents (signature data URL)
        App->>DB: insert consent_signatures
        App->>Stripe: (none yet)
        Note over App,DB: render PDF, upload to GCS,<br/>persist storage_path
    end
    App->>App: transitions.markConsentsSigned
    App->>DB: state → awaiting_deposit
    App->>Gmail: send deposit_link email
    Gmail-->>Client: "Pay your deposit"

    %% ── Deposit (Stripe Checkout) ────────────────────────────
    Client->>App: GET /c/:token/checkout
    App->>Stripe: upsertCustomer + createCheckoutSession
    App-->>Client: 302 to Stripe-hosted checkout
    Client->>Stripe: card details + pay
    Stripe-->>Client: 302 /c/:token/checkout/success
    Stripe->>App: webhook payment_intent.succeeded
    App->>DB: insert payments(kind=deposit, status=succeeded)
    App->>DB: audit_event deposit_paid

    %% ── Date confirmation + scheduling ───────────────────────
    Admin->>App: GET /admin/clients/:id (sees Confirm dates CTA)
    Admin->>App: POST /admin/clients/:id/confirm-dates
    App->>App: transitions.confirmDates
    App->>DB: state → scheduled, scheduled_*_date set
    App->>Gmail: send dates_confirmed (with .ics attachment)
    Cron->>App: POST /api/cron/state-transitions (per-minute)
    App->>DB: scheduled → in_progress (when start ≤ today)

    %% ── Completion + final charge ───────────────────────────
    Admin->>App: POST /admin/clients/:id/complete (actual day counts)
    App->>App: transitions.submitCompletion
    App->>DB: lock actuals, recompute total_actual_cents
    App->>Stripe: PaymentIntent off_session (final balance)

    alt charge succeeded
        Stripe-->>App: status=succeeded
        App->>DB: insert payments(kind=final, status=succeeded)
        App->>App: transitions.markCompleted
        App->>DB: state → completed
        App->>Gmail: send completion_receipt
    else charge failed
        Stripe-->>App: status=requires_action / failed
        App->>App: transitions.markFinalChargeFailed
        App->>DB: state → final_charge_failed,<br/>captured client_secret if 3DS
        App->>Gmail: send final_charge_failed (recovery links)

        %% Recovery branch ─────────────────────────────────────
        opt client updates card
            Client->>App: GET /c/:token/update-payment
            App->>Stripe: createPortalSession
            App-->>Client: 302 to Stripe Customer Portal
            Client->>Stripe: swap card
        end
        opt 3DS confirmation
            Client->>App: GET /c/:token/confirm-payment
            App-->>Client: Stripe.js + client_secret page
            Client->>Stripe: confirmCardPayment
        end

        Cron->>App: POST /api/cron/retry-failed-charges (24h, then 72h)
        App->>Stripe: PaymentIntent off_session (idempotency final:<id>:N)
        alt retry succeeded
            App->>DB: state → completed
            App->>Gmail: send completion_receipt
        else retry exhausted (3 attempts)
            App->>Gmail: send final_charge_retry_exhausted (escalation)
        end
    end

    %% ── Cancellation (any non-terminal state) ───────────────
    opt admin cancels
        Admin->>App: POST /admin/clients/:id/cancel
        App->>App: transitions.cancel
        App->>DB: state → cancelled
        App->>Gmail: send cancellation_notice (support + therapist)
    end
```

## State summary

| State | Entry | Next | Notes |
|-------|-------|------|-------|
| `draft` | client+retreat insert | `awaiting_consents` | sendConsentPackage |
| `awaiting_consents` | consent email sent | `awaiting_deposit` | markConsentsSigned (last sig) |
| `awaiting_deposit` | consents complete | `scheduled` | deposit_paid + confirmDates |
| `scheduled` | confirmDates | `in_progress` | cron, when start ≤ today |
| `in_progress` | start date reached | `completed` / `final_charge_failed` | submitCompletion |
| `completed` | final charge succeeded | (terminal) | receipt sent |
| `final_charge_failed` | final charge failed | `completed` / (exhausted) | retry cron 24h then 72h |
| `cancelled` | admin cancel | (terminal) | cancel allowed pre-completion |

## Where to view live

Production base: `https://clients.intensivetherapyretreat.com`  
Dev base: `https://itr-client-hq-buejbopu5q-uc.a.run.app`

To open any `/c/:token` page in the browser, copy the **Public client URL**
shown on `/admin/clients/<retreatId>` after signing in.
