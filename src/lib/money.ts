/**
 * All money in this app is integer cents, and all rates are integer basis points. These are the
 * only conversion points for either.
 *
 * One place per direction, not an open-coded `* 100` at each call site. The cents invariant has
 * held all phase precisely because `dollarsToCents` is the only multiplication — the rate
 * invariant is newer and was, until this task's review, `/ 100` written out at three sites, one
 * of which fed a form field that wrote back into storage.
 */

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100)
}

export function centsToDollars(cents: number): number {
  return cents / 100
}

/**
 * A percentage as integer basis points: 5.25% is 525.
 *
 * The same shape as `dollarsToCents` and for the same reason — `apr_bps` is an `integer` column,
 * so an unrounded 5.25 does not survive the trip at all, and an unmultiplied one truncates to 5.
 */
export function percentToBps(percent: number): number {
  return Math.round(percent * 100)
}

/** Basis points back to a percentage: 525 is 5.25. */
export function bpsToPercent(bps: number): number {
  return bps / 100
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function formatCents(cents: number): string {
  // `+ 0` normalises -0 to +0, so a computed zero (e.g. -totalDebt when the total is
  // zero) renders "$0.00" rather than "-$0.00".
  return USD.format(centsToDollars(cents) + 0)
}
