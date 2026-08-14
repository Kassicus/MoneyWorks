/**
 * Net worth is derived, never stored. The database holds one balance snapshot per account
 * per day plus a row per manual-asset valuation; net worth on any date is computed from
 * those here, at query time. Correcting a wrong balance therefore fixes the whole history.
 *
 * Dates are ISO `yyyy-mm-dd` strings, which sort correctly as plain strings — that is why
 * they are compared with `<`/`>` rather than parsed.
 */

export type AccountBalance = {
  accountId: string
  isAsset: boolean
  date: string // ISO yyyy-mm-dd
  balance: number // integer cents, positive magnitude
}

export type ManualAssetValue = {
  /** Identity across revaluations. Revaluing appends a row with a new id but the same name. */
  name: string
  isAsset: boolean
  asOf: string // ISO yyyy-mm-dd
  value: number // integer cents, positive magnitude
}

/**
 * Latest entry per key whose date is on or before `date`.
 *
 * Keys with no entry at all on or before `date` are simply absent from the result — the
 * caller treats that as zero. Where two entries share a key and a date, the first in input
 * order wins; for snapshots the (account, date) primary key makes that unreachable.
 */
function latestOnOrBefore<T extends { date: string }>(
  rows: T[],
  date: string,
  keyOf: (row: T) => string,
): T[] {
  const best = new Map<string, T>()
  for (const row of rows) {
    if (row.date > date) continue
    const k = keyOf(row)
    const current = best.get(k)
    if (!current || row.date > current.date) best.set(k, row)
  }
  return [...best.values()]
}

/**
 * Net worth in integer cents on `date`: every account's and manual asset's most recent
 * value carried forward from on or before that date, assets added and liabilities
 * subtracted. Liabilities are stored as positive magnitudes, so they are negated here.
 */
export function netWorthOn(
  date: string,
  snapshots: AccountBalance[],
  manual: ManualAssetValue[],
): number {
  const accountRows = latestOnOrBefore(snapshots, date, (r) => r.accountId)
  const manualRows = latestOnOrBefore(
    manual.map((m) => ({ ...m, date: m.asOf })),
    date,
    (r) => r.name,
  )

  let total = 0
  for (const r of accountRows) total += r.isAsset ? r.balance : -r.balance
  for (const r of manualRows) total += r.isAsset ? r.value : -r.value
  return total
}

/** One point per requested date, in the order given, for charting a net worth history. */
export function netWorthSeries(
  dates: string[],
  snapshots: AccountBalance[],
  manual: ManualAssetValue[],
): { date: string; netWorth: number }[] {
  return dates.map((date) => ({ date, netWorth: netWorthOn(date, snapshots, manual) }))
}
