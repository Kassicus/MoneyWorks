/** All money in this app is integer cents. These are the only conversion points. */

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100)
}

export function centsToDollars(cents: number): number {
  return cents / 100
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function formatCents(cents: number): string {
  // `+ 0` normalises -0 to +0, so a computed zero (e.g. -totalDebt when the total is
  // zero) renders "$0.00" rather than "-$0.00".
  return USD.format(centsToDollars(cents) + 0)
}
