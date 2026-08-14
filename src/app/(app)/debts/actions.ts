/**
 * Everything the debts-and-goals page does to the database: two writes and the read they feed.
 *
 * A **plain module, not a Server Action module** — no `'use server'`. Each function takes the
 * database handle as an argument, which is both why they are directly testable against real
 * SQL and why they cannot be actions: a `Db` is not serialisable across the action boundary.
 * `page.tsx` wraps them in inline `'use server'` functions that supply the handle.
 *
 * Nothing here feeds net worth. Debt terms and goals are context — the APR the owner is
 * paying, the payment they owe each month, the target they are saving towards — and the
 * numbers on this page are entered and displayed, never projected. No amortisation, no payoff
 * date arithmetic, no goal forecasting: those are Phase 2, and they belong in tested pure
 * functions next to `net-worth.ts`, not in a page.
 */

import { asc, eq } from 'drizzle-orm'
import { accounts, debts, goals } from '@/db/schema'
import type { Db } from '@/db/types'
import { dollarsToCents } from '@/lib/money'
import { loadNetWorthInputs } from '@/lib/queries'

/**
 * Terms are **upserted on `accountId`** — one row per account, revised in place.
 *
 * Deliberately unlike a manual asset's valuation, which appends. A valuation is a historical
 * fact that past net worth is derived from, so overwriting one rewrites a settled month. An
 * APR is a *current* fact about a loan that nothing historical is computed from: when the
 * owner refinances from 5.25% to 4%, the answer to "what am I paying?" is 4%, and a second row
 * would only make that question ambiguous.
 *
 * APR is stored as **integer basis points**, matching the `integer` column and the project-wide
 * rule that rates are basis points as money is cents: 5.25% is 525. Storing 5.25 would
 * truncate to 5 in an integer column — a $250,000 mortgage's rate silently rounded by a
 * quarter point — and storing the percent as-is loses every fraction of a point.
 */
export async function setDebtTerms(db: Db, input: {
  accountId: string; aprPercent: number; minimumPaymentDollars: number; targetPayoff: string | null
}) {
  const values = {
    accountId: input.accountId,
    aprBps: rateBps(input.aprPercent),
    minimumPayment: paymentCents(input.minimumPaymentDollars),
    targetPayoff: input.targetPayoff,
  }
  await db.insert(debts).values(values).onConflictDoUpdate({
    target: debts.accountId,
    set: {
      aprBps: values.aprBps,
      minimumPayment: values.minimumPayment,
      // Set unconditionally, including to null. Clearing the date is the only way to withdraw
      // a payoff target, and a conditional update would make it un-clearable.
      targetPayoff: values.targetPayoff,
    },
  })
}

/**
 * Appends a goal. Two goals with the same name are two goals.
 *
 * No duplicate-name guard, unlike `addManualAsset`. There the name is identity — `netWorthOn`
 * groups valuations by it, so two assets sharing a name merge and one silently stops counting.
 * A goal's name is a label on a row keyed by `id` and read by nothing that computes: "Holiday"
 * saved for twice is two goals, and refusing the second would be inventing a rule.
 */
export async function addGoal(db: Db, input: {
  name: string; targetAmountDollars: number; targetDate: string | null; linkedAccountId: string | null
}) {
  const name = input.name.trim()
  if (!name) throw new Error('A goal needs a name.')
  await db.insert(goals).values({
    name,
    targetAmount: goalTargetCents(input.targetAmountDollars),
    targetDate: input.targetDate,
    linkedAccountId: input.linkedAccountId,
  })
}

/**
 * A rate in integer basis points, or a thrown error.
 *
 * `NaN` is what `Number(formData.get('apr'))` yields for an empty or junk field, and
 * `Math.round(NaN)` is `NaN`, which reaches Postgres as an unhelpful driver error on an
 * integer column. A negative APR is a loan that pays the borrower.
 */
function rateBps(aprPercent: number): number {
  if (!Number.isFinite(aprPercent) || aprPercent < 0) {
    throw new Error(`An APR must be a non-negative percentage, not ${aprPercent}.`)
  }
  return Math.round(aprPercent * 100)
}

/** A minimum payment in integer cents, or a thrown error. Same two failures as `rateBps`. */
function paymentCents(minimumPaymentDollars: number): number {
  if (!Number.isFinite(minimumPaymentDollars) || minimumPaymentDollars < 0) {
    throw new Error(
      `A minimum payment must be a non-negative number of dollars, not ${minimumPaymentDollars}.`,
    )
  }
  return dollarsToCents(minimumPaymentDollars)
}

/**
 * A goal target in integer cents, or a thrown error.
 *
 * Strictly positive, not merely non-negative: a target of zero is a goal that is met the moment
 * it is created, and it is also the denominator of the progress percentage this page renders.
 */
function goalTargetCents(targetAmountDollars: number): number {
  if (!Number.isFinite(targetAmountDollars) || targetAmountDollars <= 0) {
    throw new Error(
      `A goal's target must be a positive number of dollars, not ${targetAmountDollars}.`,
    )
  }
  return dollarsToCents(targetAmountDollars)
}

/** The terms set against one loan. */
export type DebtTerms = {
  /** Integer basis points: 5.25% is 525. */
  aprBps: number
  /** Integer cents. */
  minimumPayment: number
  targetPayoff: string | null
}

/** One liability account as the page lists it, with its terms if any have been set. */
export type DebtListing = {
  accountId: string
  name: string
  /**
   * The most recent snapshot balance, in integer cents as a positive magnitude — or **null
   * when the account has no snapshot at all**, which is not the same as a balance of zero. An
   * account row is written before its first snapshot and `applySync` is not transactional, so
   * a run that dies in between leaves exactly this state; rendering it as `$0.00` would tell
   * the owner a debt was paid off.
   */
  balance: number | null
  /**
   * All three terms together, or null when none have been set. One nullable object rather than
   * three nullable fields, because they are set and cleared as a unit: separately, the page
   * would have to render a payment with a `?? 0` fallback that can only ever print a debt's
   * minimum payment as $0.00 if the invariant is already broken.
   */
  terms: DebtTerms | null
}

/** One goal as the page lists it, with the progress its linked account implies. */
export type GoalListing = {
  id: string
  name: string
  /** Integer cents. Guaranteed positive by `addGoal`. */
  targetAmount: number
  targetDate: string | null
  linkedAccountId: string | null
  /**
   * The linked account's most recent balance in integer cents, or **null when progress is
   * unknown** — no account is linked, or the linked one has never been snapshotted. Null and
   * zero are different answers: zero says "you have saved nothing", null says "nothing here
   * knows".
   */
  saved: number | null
}

/** An account the goal form can link to, by id and name. */
export type AccountOption = { id: string; name: string }

/**
 * Everything the page renders, in one read.
 *
 * It lives here rather than inline in the page for the same reason `latestManualAssets` does:
 * it is the call the page's auth test asserts was *not* made for a caller who is not the
 * owner, and a gate that can only be proven by a mocked drizzle chain is a gate nobody tests.
 *
 * Balances come from `loadNetWorthInputs`, which loads whole snapshot history — the same rows
 * the dashboard's figure is derived from, so the balance shown against a debt here and the
 * balance subtracted there cannot disagree.
 */
export async function loadDebtsAndGoals(db: Db): Promise<{
  debts: DebtListing[]
  goals: GoalListing[]
  accountOptions: AccountOption[]
}> {
  const accountRows = await db.select({
    id: accounts.id,
    name: accounts.name,
    isAsset: accounts.isAsset,
  }).from(accounts).orderBy(asc(accounts.name))

  const termRows = await db.select().from(debts)
  const goalRows = await db.select().from(goals).orderBy(asc(goals.name))
  const { snapshots } = await loadNetWorthInputs(db)

  // The latest snapshot per account. `date` is an ISO `YYYY-MM-DD` string, so a string
  // comparison is a date comparison.
  const latest = new Map<string, { date: string; balance: number }>()
  for (const s of snapshots) {
    const current = latest.get(s.accountId)
    if (!current || s.date > current.date) latest.set(s.accountId, s)
  }
  const balanceOf = (accountId: string | null): number | null =>
    accountId === null ? null : latest.get(accountId)?.balance ?? null

  const termsFor = new Map(termRows.map((t) => [t.accountId, t]))

  return {
    // Liabilities only. This page is about what is owed; an asset account has no APR and no
    // minimum payment, and offering it a terms form would invite entering one.
    debts: accountRows.filter((a) => !a.isAsset).map((a) => {
      const t = termsFor.get(a.id)
      return {
        accountId: a.id,
        name: a.name,
        balance: balanceOf(a.id),
        terms: t
          ? { aprBps: t.aprBps, minimumPayment: t.minimumPayment, targetPayoff: t.targetPayoff }
          : null,
      }
    }),
    goals: goalRows.map((g) => ({
      id: g.id,
      name: g.name,
      targetAmount: g.targetAmount,
      targetDate: g.targetDate,
      linkedAccountId: g.linkedAccountId,
      saved: balanceOf(g.linkedAccountId),
    })),
    // Every account, not only the liabilities. The plan restricted this dropdown to
    // liabilities because Phase 1 had no synced asset accounts when it was written; it has
    // them now, and a savings goal is overwhelmingly linked to a savings account.
    accountOptions: accountRows.map((a) => ({ id: a.id, name: a.name })),
  }
}
