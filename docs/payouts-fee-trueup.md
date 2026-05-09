# Stripe fee true-up — v0.29.0+ design

**Status:** Design only. Not implemented. v0.27.0 ships an estimate-only
fee model; this doc captures the path to add post-charge true-up if
real-world deltas warrant it.

## Why true-up?

Today (v0.27.0), `src/lib/stripe.ts:buildConnectParams` deducts an
**estimated** Stripe processing fee before splitting the gross between
therapist (Connect destination) and platform (`application_fee_amount`):

```text
est_fee_cents = round(gross * 0.029) + 30      # 2.9% + 30¢ US card baseline
net           = gross - est_fee_cents
ts            = floor(net * pct / 100)         # therapist transfer
fee           = gross - ts                      # application_fee_amount
```

Real Stripe fees vary:

- **US standard card**: 2.9% + 30¢. Estimate is exact.
- **Premium rewards / corporate card**: ~2.9% + 30¢ + ~0.5% (Visa/MC
  interchange surcharge passed through). Estimate underpays platform
  by ~$5 on $1k.
- **International card**: +1.5% (≈$15 underpay on $1k).
- **Connect Express add-on**: 0.25% + 25¢ on the connected-account
  portion (separate billing line, not deducted from the same charge).
- **ACH / Affirm / etc.**: completely different fee structures.

When estimate < actual, the platform absorbs the delta out of its 40%
cut. When estimate > actual (rare for cards), the therapist is short
by sub-cent → platform absorbs that too.

## When to ship true-up

Skip until **at least one full month of post-deploy production data**
shows a sustained underestimation. Useful triggers:

- Average platform delta > $5/charge across 30 days
- Therapist complaints about payout amount (shouldn't happen — they
  always get exactly `pct%` of NET as estimated; they're insulated from
  variance)
- Affirm or ACH go live (their fee structures don't fit the constant)

If none of these hit, the estimate model is fine forever.

## Implementation sketch

### 1. New webhook handler: `charge.updated`

Stripe emits `charge.updated` when `balance_transaction` is finalised
(seconds to minutes after `charge.succeeded`). The balance transaction
carries the **actual** processor fee in `fee` and `fee_details`.

Add to `src/routes/api/webhooks-stripe.ts`:

```ts
case 'charge.updated': {
  const charge = event.data.object as Stripe.Charge;
  if (!charge.balance_transaction) return;     // not yet finalised
  if (typeof charge.balance_transaction === 'string') {
    // Need to expand — re-fetch.
    const bt = await client.balanceTransactions.retrieve(charge.balance_transaction);
    await trueUpPayout(charge, bt);
  } else {
    await trueUpPayout(charge, charge.balance_transaction);
  }
  return;
}
```

### 2. True-up reconciliation

```ts
async function trueUpPayout(charge, balanceTx) {
  // 1. Find our payouts row by stripe_charge_id (via source_transaction).
  const [payout] = await db.select().from(payouts).where(...);
  if (!payout) return;                          // not a Connect charge

  const estFee = ...;                           // recompute from gross + pct
  const actualFee = balanceTx.fee;
  const delta = actualFee - estFee;             // + means we underestimated

  // Threshold: only true-up when delta > $1 (avoid noise on every charge).
  if (Math.abs(delta) < 100) return;

  if (delta > 0) {
    // We owe the platform: pull `delta` back from connected account.
    await client.transfers.createReversal(payout.stripe_transfer_id, {
      amount: delta,
      description: 'Fee true-up — actual > estimated',
    });
  } else {
    // We over-collected: push `|delta|` extra to connected account.
    await client.transfers.create({
      amount: -delta,
      currency: 'usd',
      destination: payout.destination_account_id,
      transfer_group: charge.transfer_group,
    });
  }

  // Record adjustment row in payouts (or a new payout_adjustments table).
  await db.insert(payoutAdjustments).values({
    payout_id: payout.id,
    delta_cents: delta,
    actual_fee_cents: actualFee,
    estimated_fee_cents: estFee,
  });
}
```

### 3. Schema addition (migration 0012-ish)

```sql
CREATE TABLE payout_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  delta_cents integer NOT NULL,
  actual_fee_cents integer NOT NULL,
  estimated_fee_cents integer NOT NULL,
  stripe_reversal_id text,
  stripe_extra_transfer_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_adjustments_payout_idx ON payout_adjustments(payout_id);
```

### 4. Admin UI

Extend `/admin/payouts` row to show adjustment delta when present.
Extend the per-retreat Payments card subrow on `/admin/clients/:id`
similarly.

## Tradeoffs

- **Webhook complexity**: `charge.updated` fires multiple times during
  a charge's lifecycle. Idempotency on `payout_adjustments(payout_id,
  actual_fee_cents)` prevents duplicate reversals.
- **Reversal vs new-transfer races**: Connect won't let you reverse a
  transfer that's already been paid out from the connected account
  (instant payouts); use `transfers.createReversal` only while balance
  is still on Connect side. For payouts already paid out, reconcile
  off-platform via accounting.
- **Refund interaction**: when a charge is refunded with
  `refund_application_fee: true + reverse_transfer: true`, the
  adjustment must also be reversed. Track this in
  `payout_adjustments.refunded_at` and gate reverse logic.

## Decision criteria — should we ship this?

| Trigger | Ship if |
|---|---|
| 30-day median delta < $2/charge | No — keep estimate |
| 30-day median delta $2–$5 | Borderline — depends on charge volume |
| 30-day median delta > $5 | Yes — losses compound |
| ACH / Affirm goes live | Yes — fee model needs per-method math anyway |
| Therapist payouts wrong by > 1¢ | Already a bug in v0.27.0 — fix immediately, true-up unrelated |

Re-evaluate quarterly.
