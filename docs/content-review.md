# Content review checklist

Send this to legal/branding/clinical leadership before any real client uses
the system. Every user-visible string is enumerated below with file refs
so reviewers can give scoped feedback.

## 1. Email content

All emails composed in `src/lib/notifications.ts → compose()`. Bodies are
intentionally minimal (PHI-free) — they link back to the authenticated
surface for detail.

| Event | Subject | Body (text) | Recipients |
|-------|---------|-------------|------------|
| `consent_package_sent` | `Your Intensive Therapy Retreats consent package` | "Hi {firstName}, Your therapist has prepared your consent package. Please review and sign at the link below — it is unique to you. {url} If you have questions, reply to this email and our team will be in touch." | client + internal |
| `consents_signed` | `Consents signed [ret #abcd1234]` | `All required consents have been signed. {adminUrl}` | internal |
| `deposit_paid` | `Deposit paid — please confirm dates [ret #abcd1234]` | `Deposit paid. Please confirm dates: {adminUrl}` | internal + assigned therapist |
| `dates_confirmed` | `Retreat dates confirmed [ret #abcd1234]` | `Retreat dates have been confirmed. {adminUrl}` (+ `.ics` attachment) | internal |
| `in_progress` | `Retreat in progress [ret #abcd1234]` | `Retreat marked in progress. {adminUrl}` | internal |
| `completion_submitted` | `Retreat completion submitted [ret #abcd1234]` | `Therapist submitted completion form. {adminUrl}` | internal |
| `final_charged` | `Final balance charged [ret #abcd1234]` | `Final balance charged successfully. {adminUrl}` | internal |
| `final_charge_failed` | `Action needed: final charge failed [ret #abcd1234]` | `Final charge failed for a retreat. Action needed: {adminUrl}` | internal + assigned therapist |
| `final_charge_retry_exhausted` | `Action needed: final charge retry attempts exhausted [ret #abcd1234]` | `All retry attempts for the final charge have failed (3/3). Manual recovery required: {adminUrl}` | internal + assigned therapist |
| `cancelled` | `Retreat cancelled [ret #abcd1234]` | `Retreat cancelled. {adminUrl}` | internal |

**Review questions:**
- Is the client-facing email copy (`consent_package_sent`) clinically + legally appropriate?
- Should the client receive a deposit-receipt email? (currently they only see Stripe's auto-receipt)
- Should the client receive a final-charge receipt? (currently only Stripe's)
- Subject-line conventions for internal emails — `[ret #...]` tagging acceptable?
- Reply-to address — currently sends from `clients@intensivetherapyretreat.com`. Confirm.

## 2. Consent templates

Markdown files in `src/consents/`. Versioned + immutable once published. Each
retreat snapshots the active version at creation time.

| File | Title | Requires signature | Effective date |
|------|-------|-------------------|----------------|
| `informed-consent-v1.md` | Information and Consent for Treatment | yes | n/a |
| `notice-of-privacy-practices-v1.md` | Notice of Privacy Practices | no | 2020-07-14 |
| `emergency-contact-release-v1.md` | Emergency Contact Release Form | yes | n/a |

**Review questions for each template:**
- Body text accuracy (clinical + legal)
- Required fields complete + labels accurate
- HIPAA / state-of-residence specific clauses present
- Signature capture meets jurisdiction requirements (typed name + IP +
  user-agent + canvas image are all stored — see DESIGN.md §7)
- Versioning policy: any changes need a v2 file (immutable v1 stays)

## 3. Public client-facing UI copy

Surfaces under `/c/<token>/*`. Files in `src/routes/public/`.

### `/c/:token` — status page (`consents.tsx`)

Headers and copy:
- `"Hi {firstName},"`
- `"Your therapist is {therapistFullName}."`
- `"Required documents"` (heading)
- Document status badges: `"signed"`, `"not yet signed"`, `"informational"`
- `"All consents signed. We are preparing your deposit checkout — you will receive a follow-up email."`
- `"All consents are signed. Deposit checkout link is coming next."`
- `"Your retreat is scheduled. See you soon."`
- `"All consents will be stored securely and you will receive a copy when complete."`

### `/c/:token/consents` — sign page

- Card title: `"Required information"`
- Signature card title: `"Signature"` + `"Sign in the box below using your mouse or finger."`
- Submit button: `"Sign and continue"` / `"Acknowledge and continue"`
- Field label: `"Printed name"`

### `/c/:token/checkout/success`

- `"Thanks — your deposit is received."` / `"Your deposit is processing."`
- Body: `"Your therapist will confirm your retreat dates next. We'll email you when they do."`
- `"We haven't received the payment confirmation yet. Refresh in a moment, or check your email."`
- Link: `"Back to retreat status"`

### `/c/:token/payment-updated`

- `"Payment method updated"`
- `"Thank you. Your saved payment method has been updated. Our team will retry the outstanding charge automatically within 24 hours."`
- `"If you have questions, reply to the email you received from us and our team will be in touch."`

### `/c/:token/confirm-payment`

- `"Confirm your payment"`
- `"Your bank requires an extra verification step before we can complete the charge. Click the button below to confirm — you may be asked to authenticate with your bank."`
- Button: `"Confirm payment"`
- `"No pending payment confirmation"` (when nothing to confirm)
- `"There's nothing to confirm right now. If you received an email asking you to confirm a payment, please reply to that email so our team can help."`

**Review questions:**
- Tone (clinical / professional / warm) — consistent?
- "Our team" framing acceptable, or should it name the practice?
- Stripe-specific language ("your bank requires…") technically accurate?

## 4. Admin / staff UI copy

Surfaces under `/admin/*`. Files in `src/routes/admin/` and `src/routes/auth/login.tsx`.

### Sign-in (`/admin/login`)

- `"ITR Clients"` (h1)
- `"Sign in with your @intensivetherapyretreat.com Google account."`
- Button: `"Sign in with Google"`
- `"Sessions last 5 days. After that you'll be asked to sign in again."`

### Dashboard

- `"Retreats"`, `"+ New client"`, `"Pricing config"`
- Filter labels: `"State"`, `"Therapist"`, `"Filter"`, `"Clear"`
- Table columns: `"Id"`, `"Client"`, `"Therapist"`, `"State"`, `"Scheduled"`, `"Total"`, `"Created"`

### New client form

- Card titles: `"Therapist"`, `"Client"`, `"Retreat"`, `"Pricing"`
- All field labels (see `src/routes/admin/clients-new.tsx` lines 80–155)
- Helper text: `"Override rates only when basis is sliding-scale or comp. Leave blank to use therapist default."`
- Submit: `"Create + send consent package"`

### Detail page

- Section titles: `"Client + therapist"`, `"Pricing"`, `"Scheduled dates"`, `"Next step"`, `"Required consents"`, `"Audit log"`, `"Email log"`
- Recovery copy (when `final_charge_failed`): `"Auto-retry runs at 24h then 72h cadence via the retry cron. Client recovery links: Update saved card (Stripe portal): {url}, 3DS hosted-confirmation page: {url}"`

### Action forms (confirm-dates, complete, refund, cancel)

- Each has descriptive copy explaining what the action does + state requirements. See files for full text.
- Cancel checkbox: `"I understand this cannot be undone."`
- Cancel description: `"Moves retreat to cancelled and emails support + the assigned therapist. Refunds handled separately on the Refund form — process those first if you want them recorded."`

**Review questions:**
- Brand voice: "ITR Clients" preferred over "ITR Client HQ" — confirm consistency
- State-machine state names visible to admins: `awaiting_consents`, `awaiting_deposit`, `scheduled`, `in_progress`, `completed`, `final_charge_failed`, `cancelled`. Want any renamed for staff readability?
- Pricing-basis labels: `Standard`, `Sliding scale`, `Comp` — acceptable?

## 5. Brand assets

- Logo: `src/assets/brand/logo.png` (sidebar + brand bar mark)
- Favicon: `src/assets/brand/favicon.png`
- Apple touch icon: `src/assets/brand/apple-touch-icon.png`
- Wordmarks: `"ITR Clients"` (admin) + `"Intensive Therapy Retreats"` (client-facing)

**Review questions:**
- Logo file approved by branding/marketing
- Wordmark choice — keep two (admin vs client) or unify

## How to capture feedback

For each section, mark either:
- ✅ approved as-is
- ✏️ change to: "<new text>"
- ❌ remove

Send the marked-up doc back; I'll cut a content-only PR with all changes
batched.
