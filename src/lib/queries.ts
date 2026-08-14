/**
 * The dashboard's reads. Two functions, both server-side: everything the one number and the
 * one chart need, and nothing else.
 *
 * `loadNetWorthInputs` deliberately loads *whole history*, unfiltered, and lets `netWorthOn`
 * do the arithmetic in memory. That is not an oversight to be optimised away later: net worth
 * is derived from the latest snapshot per account on or before a date, and the chart asks for
 * one such answer per day, so a SQL-side "latest per account" would have to run once per
 * point. This is one person's accounts — a few thousand rows at the end of a decade.
 */

import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { balanceSnapshots, manualAssets, syncRuns } from '@/db/schema'
import type { Db } from '@/db/types'
import type { AccountBalance, ManualAssetValue } from './net-worth'

export async function loadNetWorthInputs(db: Db): Promise<{
  snapshots: AccountBalance[]
  manual: ManualAssetValue[]
}> {
  // No join to `accounts`, on purpose. `is_asset` is read off the SNAPSHOT, which recorded
  // the classification in force on the day it was written. `accounts.is_asset` holds only
  // the *current* classification and it moves: a credit card overpaid into credit, or a
  // checking account overdrawn, flips it. Sourcing the sign from the account row would
  // re-sign every past snapshot for that account, moving historical net worth by twice each
  // balance — the bug the snapshot's own `is_asset` column exists to prevent.
  const snapshots = await db.select({
    accountId: balanceSnapshots.accountId,
    date: balanceSnapshots.date,
    balance: balanceSnapshots.balance,
    isAsset: balanceSnapshots.isAsset,
  }).from(balanceSnapshots)

  const manualRows = await db.select({
    name: manualAssets.name,
    isAsset: manualAssets.isAsset,
    asOf: manualAssets.asOf,
    value: manualAssets.value,
    createdAt: manualAssets.createdAt,
  }).from(manualAssets)

  return {
    snapshots,
    manual: manualRows.map((m) => ({
      // Keyed by name, not id: revaluing appends a new row with a new id, so keying on id
      // would count the old and the new valuation of the same house as two houses.
      name: m.name,
      isAsset: m.isAsset,
      asOf: m.asOf,
      value: m.value,
      // `createdAt` breaks a tie between two valuations sharing an `as_of` — the same asset
      // valued and then corrected on the same day. `latestOnOrBefore` compares it as a
      // string, so drizzle's `Date` is converted here rather than compared as an object.
      // Without it the displayed number would depend on this query's ORDER BY.
      createdAt: m.createdAt.toISOString(),
    })),
  }
}

/**
 * When the last sync that actually finished successfully finished, or null if none ever has.
 *
 * Only `finished_at` is selected, and that is deliberate rather than tidy: `sync_runs.error`
 * holds `String(err)`, and drizzle's error messages embed the failing SQL statement together
 * with its bound parameters — account names, transaction descriptions. No credential, but not
 * banner copy either, and the surest way not to render it is never to load it.
 */
export async function lastSuccessfulSync(db: Db): Promise<Date | null> {
  const rows = await db.select({ finishedAt: syncRuns.finishedAt }).from(syncRuns)
    // `isNotNull` is load-bearing, not belt-and-braces: `ORDER BY ... DESC` sorts NULLs
    // FIRST in Postgres, so an 'ok' row without a finish time would win the ordering and
    // this would answer null — "never synced" — with good syncs sitting in the table.
    .where(and(eq(syncRuns.status, 'ok'), isNotNull(syncRuns.finishedAt)))
    .orderBy(desc(syncRuns.finishedAt))
    .limit(1)
  return rows[0]?.finishedAt ?? null
}
