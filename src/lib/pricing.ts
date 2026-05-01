/**
 * Pricing math (DESIGN.md §4).
 *
 * Dual pricing, not surcharge. ACH is the published rate; CC is the same rate
 * without the discount:
 *   ACH total = full_day_cents × full_days + half_day_cents × half_days
 *   CC  total = ACH total ÷ (1 − ach_discount_pct)
 *
 * Always round at the cent boundary. Snapshot the rates onto the retreat at
 * creation — DO NOT join to live pricing_config when computing a retreat
 * total later (DESIGN.md §4 snapshot rule).
 */

export type PaymentMethod = 'ach' | 'card';

export interface PriceInput {
  fullDayRateCents: number;
  halfDayRateCents: number | null;
  plannedFullDays: number;
  plannedHalfDays: number;
  achDiscountPct: number; // e.g. 0.030 for 3.0%
  paymentMethod: PaymentMethod;
}

export interface PriceBreakdown {
  achTotalCents: number;
  ccTotalCents: number;
  totalCents: number;
}

export function computePrice(input: PriceInput): PriceBreakdown {
  if (input.plannedFullDays < 0 || input.plannedHalfDays < 0) {
    throw new RangeError('day counts must be non-negative');
  }
  if (input.plannedHalfDays > 0 && input.halfDayRateCents == null) {
    throw new Error('half-day requested but therapist has no half-day rate');
  }
  if (input.achDiscountPct < 0 || input.achDiscountPct >= 1) {
    throw new RangeError('ach_discount_pct out of range');
  }

  const halfDayCents = input.halfDayRateCents ?? 0;
  const achTotalCents =
    input.fullDayRateCents * input.plannedFullDays +
    halfDayCents * input.plannedHalfDays;

  const ccTotalCents = Math.round(achTotalCents / (1 - input.achDiscountPct));

  return {
    achTotalCents,
    ccTotalCents,
    totalCents: input.paymentMethod === 'ach' ? achTotalCents : ccTotalCents,
  };
}

export function formatCents(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
