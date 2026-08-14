/**
 * Net worth is derived, never stored. The database holds one balance snapshot per account
 * per day plus a row per manual-asset valuation; net worth on any date is computed from
 * those here, at query time. Correcting a wrong balance therefore fixes the whole history.
 *
 * Dates are ISO `yyyy-mm-dd` strings, which sort correctly as plain strings — that is why
 * they are compared with `>` rather than parsed.
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
  /**
   * Row insertion time, breaking a tie between two valuations that share an `asOf` — the
   * same asset valued and then corrected on the same day. Compared lexicographically, so
   * callers must supply a uniform ISO-8601 format (`Date.prototype.toISOString()` does).
   * Optional: omit it and same-day ties fall back to input order (see `latestOnOrBefore`).
   */
  createdAt?: string
}

/**
 * Latest entry per key whose date is on or before `date`.
 *
 * Keys with no entry at all on or before `date` are absent from the result — the caller
 * treats that as zero.
 *
 * Ties on the date resolve by later `createdAt`, then by last row in input order:
 *
 * - Balance snapshots cannot tie: the `(account_id, date)` primary key forbids two rows for
 *   one account on one day, and they carry no `createdAt`.
 * - Manual-asset valuations *can* tie, and legitimately do. Revaluing appends a row rather
 *   than updating one, and nothing constrains `(name, as_of)` — valuing a house in the
 *   morning and correcting it in the afternoon produces two rows with the same `as_of`.
 *   `createdAt` decides which of the two is current, so the answer does not depend on the
 *   `ORDER BY` of whichever query loaded the rows.
 * - Unless *both* tied rows carry a `createdAt` and the two differ, the last row in input
 *   order wins. That is a defined fallback rather than a guarantee worth relying on: pass
 *   `createdAt` on both and the result stops depending on input order at all.
 */
function latestOnOrBefore<T extends { date: string; createdAt?: string }>(
  rows: T[],
  date: string,
  keyOf: (row: T) => string,
): T[] {
  const best = new Map<string, T>()
  for (const row of rows) {
    if (row.date > date) continue
    const k = keyOf(row)
    const current = best.get(k)
    if (!current || supersedes(row, current)) best.set(k, row)
  }
  return [...best.values()]
}

/** Whether `row` is the more recent of the two, later in the input than `current`. */
function supersedes<T extends { date: string; createdAt?: string }>(row: T, current: T): boolean {
  if (row.date !== current.date) return row.date > current.date
  if (row.createdAt && current.createdAt && row.createdAt !== current.createdAt) {
    return row.createdAt > current.createdAt
  }
  return true // fully tied: later in input order wins
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
