/**
 * Everything the manual-assets page does to the database: two writes and the read they feed.
 *
 * A **plain module, not a Server Action module** — no `'use server'`. Each function takes the
 * database handle as an argument, which is both why they are directly testable against real
 * SQL and why they cannot be actions: a `Db` is not serialisable across the action boundary.
 * `page.tsx` wraps them in inline `'use server'` functions that supply the handle.
 *
 * The invariant this file exists to hold: **a revaluation appends a row, it never updates
 * one.** A manual asset is a series of `(name, value, as_of)` rows, and `netWorthOn` reads
 * the most recent valuation on or before each date. Valuing a house at $400k in January and
 * $420k in July therefore leaves January's net worth saying $400k.
 */

import { asc, desc, sql } from 'drizzle-orm'
import { manualAssets } from '@/db/schema'
import type { Db } from '@/db/types'
import { dollarsToCents } from '@/lib/money'

/** One asset as the page lists it: its name and its most recent valuation. */
export type LatestValuation = {
  name: string
  kind: string
  isAsset: boolean
  /** Integer cents, a positive magnitude even for a liability. */
  value: number
  asOf: string
}

/** Zero-width space, ZWNJ, ZWJ, word joiner, BOM. None of them mark the page. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g

/**
 * A name as it is stored: composed, stripped of invisible characters, trimmed, and with runs
 * of whitespace collapsed to one space.
 *
 * The rule is *normalise what rendering makes invisible*, and it stops there. Two names that
 * draw the same glyphs in the same order are one name:
 *
 * - **Composition.** `"Café"` written NFC (U+00E9) and NFD (`e` + U+0301) are different byte
 *   strings that render identically, and both occur in real use — macOS hands out NFD from
 *   Finder while typing the name yields NFC. Postgres does no Unicode normalisation and
 *   `lower()` does not fold them, so this must happen here or not at all.
 * - **Invisible characters.** A zero-width space or a pasted BOM is not matched by JS `\s`
 *   and shows nothing on the page.
 * - **Whitespace.** HTML collapses leading, trailing and repeated whitespace, so `"My  House"`
 *   and `"My House"` are the same two words on the page.
 *
 * An accent that is *visible*, or a different word, is a different name and is left alone.
 */
function canonicalName(name: string): string {
  return name.normalize('NFC').replace(INVISIBLE, '').trim().replace(/\s+/g, ' ')
}

/**
 * Matches a stored name against one the caller typed, ignoring case and layout whitespace.
 *
 * Both functions go through it so they cannot disagree about what "the same asset" means:
 * `addManualAsset` refuses a name that matches, `revalueManualAsset` requires one that does.
 * The stored side needs no normalising because `addManualAsset` is the only writer of a new
 * name and it stores the canonical form. Case folding is done by Postgres on both sides
 * rather than by `toLowerCase()` on one, so a non-ASCII name folds by one set of rules.
 */
function sameName(name: string) {
  return sql`lower(${manualAssets.name}) = lower(${canonicalName(name)}::text)`
}

/**
 * A valuation in cents, or a thrown error.
 *
 * Liabilities are stored as a positive magnitude that net worth subtracts, so a negative
 * value is a debt with its sign applied twice. `NaN` is what `Number(formData.get('value'))`
 * produces for junk input, and it reaches Postgres as an unhelpful driver error. Neither can
 * be corrected afterwards — nothing here deletes or edits a row — so both are refused before
 * the row exists.
 */
function valuationCents(valueDollars: number): number {
  if (!Number.isFinite(valueDollars) || valueDollars < 0) {
    throw new Error(
      `A manual asset's value must be a non-negative number of dollars, not ${valueDollars}. ` +
      'Enter a liability as a positive amount and untick "this is an asset".',
    )
  }
  return dollarsToCents(valueDollars)
}

/**
 * Creates a manual asset with its first valuation.
 *
 * **A name already in use is refused**, and that is what makes name-as-identity sound.
 * `netWorthOn` groups valuations by `name` so revaluing a house counts one house rather than
 * two; the price of that is that two genuinely different assets entered under one name merge,
 * and the older one stops contributing to net worth at all — two vehicles both called "Car"
 * become one car, and the owner's net worth quietly drops by the value of the other. A unique
 * index cannot express the rule, since revaluations legitimately produce many rows sharing a
 * name, so it lives here: unique at creation, unconstrained thereafter.
 *
 * The comparison ignores case and everything `canonicalName` folds. Those variants would *not*
 * merge — they are distinct strings — but they are indistinguishable in a list, so a later
 * revaluation lands on whichever the owner happened to pick and freezes the other at its old
 * figure inside net worth, with no delete and no rename to undo it.
 */
export async function addManualAsset(db: Db, input: {
  name: string; kind: string; isAsset: boolean; valueDollars: number; asOf: string
}) {
  const name = canonicalName(input.name)
  if (!name) throw new Error('A manual asset needs a name.')
  const value = valuationCents(input.valueDollars)

  const [existing] = await db.select({ name: manualAssets.name })
    .from(manualAssets)
    .where(sameName(name))
    .limit(1)
  if (existing) {
    throw new Error(
      `A manual asset named "${existing.name}" already exists. ` +
      'Revalue it instead, or pick a different name.',
    )
  }

  await db.insert(manualAssets).values({
    name,
    kind: input.kind,
    isAsset: input.isAsset,
    value,
    asOf: input.asOf,
  })
}

/**
 * Appends a new valuation row; never mutates an existing one.
 *
 * `kind` and `isAsset` are copied from the prior row rather than accepted from the caller: a
 * revaluation that could turn an asset into a liability would flip its sign in net worth,
 * moving the total by twice the value. The stored `name` is copied forward too, so revaluing
 * "house" cannot fork the identity of "House" into a second asset.
 *
 * `created_at` is left to the column default. It is the tiebreak between two valuations that
 * share an `as_of` — valued in the morning, corrected in the afternoon — so setting it, or
 * copying the prior row's, would make the current figure depend on query order instead.
 */
export async function revalueManualAsset(db: Db, input: {
  name: string; valueDollars: number; asOf: string
}) {
  const value = valuationCents(input.valueDollars)

  // Ordered rather than arbitrary for the sake of a reader: `kind`, `isAsset` and `name` are
  // invariant across an asset's rows — this function copies them and `addManualAsset` is the
  // only other writer — so any row of the group would in fact do.
  const [prior] = await db.select().from(manualAssets)
    .where(sameName(input.name))
    .orderBy(desc(manualAssets.asOf), desc(manualAssets.createdAt))
    .limit(1)
  if (!prior) throw new Error(`No manual asset named ${input.name}`)

  await db.insert(manualAssets).values({
    name: prior.name,
    kind: prior.kind,
    isAsset: prior.isAsset,
    value,
    asOf: input.asOf,
  })
}

/**
 * One entry per asset, holding its most recent valuation, ordered by name.
 *
 * The whole table in, the current picture out — the same shape as `loadNetWorthInputs`, and
 * for the same reason: the history is one person's few hundred rows, and doing the reduction
 * in memory keeps the rule about which valuation is current in TypeScript, where it can be
 * read, instead of splitting it between a window function and `netWorthOn`.
 *
 * Ties on `as_of` break by `created_at`, as `netWorthOn` breaks them, so the figure this page
 * shows and the figure the dashboard counts agree on which valuation is current.
 *
 * On a *full* tie — same `as_of` and same `created_at` — the two do diverge: this keeps the
 * first such row of the loaded order, while `latestOnOrBefore` keeps the last. Unreachable in
 * production, because `now()` is microsecond-resolution *in production Postgres* and each
 * write here is its own transaction, so no two rows can share a `created_at`. That is a claim
 * about the production driver only: PGlite's `now()` is millisecond-resolution, which is
 * exactly why `tests/app/assets-actions.test.ts` pauses 5 ms between two writes whose tiebreak
 * it means to test. The tie also stops being unreachable the moment two writes are wrapped in
 * one `db.transaction`: Postgres `now()` is the *transaction* timestamp, so both rows would be
 * stamped identically. Left as is rather than aligned, because a full tie is undecidable from
 * the data — the rows carry nothing else that orders them — and the fix belongs wherever that
 * transaction is introduced.
 *
 * Valuations dated in the future are *not* filtered out. They do not count towards net worth
 * until their date arrives, but the asset must still appear here — it is the only place the
 * owner can see it, and its name is what the revalue form offers.
 */
export async function latestManualAssets(db: Db): Promise<LatestValuation[]> {
  const rows = await db.select({
    name: manualAssets.name,
    kind: manualAssets.kind,
    isAsset: manualAssets.isAsset,
    value: manualAssets.value,
    asOf: manualAssets.asOf,
    createdAt: manualAssets.createdAt,
  }).from(manualAssets).orderBy(asc(manualAssets.name), asc(manualAssets.createdAt))

  const latest = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const current = latest.get(row.name)
    if (!current || row.asOf > current.asOf) latest.set(row.name, row)
    else if (row.asOf === current.asOf && row.createdAt > current.createdAt) {
      latest.set(row.name, row)
    }
  }

  return [...latest.values()].map((r) => ({
    name: r.name, kind: r.kind, isAsset: r.isAsset, value: r.value, asOf: r.asOf,
  }))
}
