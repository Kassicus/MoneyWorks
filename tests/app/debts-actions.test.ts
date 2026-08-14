import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { setDebtTerms, addGoal, loadDebtsAndGoals } from '@/app/(app)/debts/actions'
import { accounts, balanceSnapshots, debts, goals } from '@/db/schema'
import type { Db } from '@/db/types'

/**
 * Real SQL against a real (PGlite) database throughout, for the same reason as
 * `assets-actions.test.ts`: these functions are composition, and a mocked handle would only
 * assert that drizzle was called the way drizzle was called. Every assertion below is a row
 * that came back out of Postgres.
 */

const addAccount = (db: Db, name: string, isAsset: boolean) =>
  db.insert(accounts)
    .values({ name, type: isAsset ? 'savings' : 'liability', isAsset })
    .returning()
    .then(([a]) => a.id)

const snapshot = (db: Db, accountId: string, date: string, balance: number, isAsset = false) =>
  db.insert(balanceSnapshots).values({ accountId, date, balance, isAsset })

describe('debts and goals', () => {
  it('stores APR as integer basis points and payment as cents', async () => {
    const { db, close } = await makeTestDb()
    const [a] = await db.insert(accounts)
      .values({ name: 'Car Loan', type: 'liability', isAsset: false }).returning()

    await setDebtTerms(db, {
      accountId: a.id, aprPercent: 5.25, minimumPaymentDollars: 412.5, targetPayoff: null,
    })

    const rows = await db.select().from(debts)
    expect(rows[0].aprBps).toBe(525)
    expect(rows[0].minimumPayment).toBe(41250)
    await close()
  })

  it('upserts terms for an account rather than duplicating', async () => {
    const { db, close } = await makeTestDb()
    const [a] = await db.insert(accounts)
      .values({ name: 'Car Loan', type: 'liability', isAsset: false }).returning()

    await setDebtTerms(db, { accountId: a.id, aprPercent: 5.25, minimumPaymentDollars: 412.5, targetPayoff: null })
    await setDebtTerms(db, { accountId: a.id, aprPercent: 4.0, minimumPaymentDollars: 400, targetPayoff: null })

    const rows = await db.select().from(debts)
    expect(rows).toHaveLength(1)
    expect(rows[0].aprBps).toBe(400)
    await close()
  })

  it('stores a goal target in cents', async () => {
    const { db, close } = await makeTestDb()
    await addGoal(db, {
      name: 'Emergency fund', targetAmountDollars: 15000, targetDate: '2027-01-01', linkedAccountId: null,
    })
    const rows = await db.select().from(goals)
    expect(rows[0].targetAmount).toBe(1500000)
    await close()
  })

  /**
   * The half of "upsert" the length assertion above does not reach. The revision writes every
   * term, including a payoff date set back to null — clearing the date is the only way to
   * withdraw a target, and a conditional `set` would leave the old one attached to new terms.
   */
  it('replaces every term on revision, including clearing a payoff date', async () => {
    const { db, close } = await makeTestDb()
    const id = await addAccount(db, 'Car Loan', false)

    await setDebtTerms(db, {
      accountId: id, aprPercent: 5.25, minimumPaymentDollars: 412.5, targetPayoff: '2029-06-01',
    })
    await setDebtTerms(db, {
      accountId: id, aprPercent: 4, minimumPaymentDollars: 400, targetPayoff: null,
    })

    const [row] = await db.select().from(debts)
    expect(row).toMatchObject({ aprBps: 400, minimumPayment: 40000, targetPayoff: null })
    await close()
  })

  /** Terms are per account. Revising one loan must not touch the terms of another. */
  it('keeps each account’s terms to itself', async () => {
    const { db, close } = await makeTestDb()
    const car = await addAccount(db, 'Car Loan', false)
    const card = await addAccount(db, 'Credit Card', false)

    await setDebtTerms(db, { accountId: car, aprPercent: 5.25, minimumPaymentDollars: 412.5, targetPayoff: null })
    await setDebtTerms(db, { accountId: card, aprPercent: 22.99, minimumPaymentDollars: 35, targetPayoff: null })
    await setDebtTerms(db, { accountId: car, aprPercent: 4, minimumPaymentDollars: 400, targetPayoff: null })

    const rows = await db.select().from(debts)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.accountId === card)).toMatchObject({ aprBps: 2299, minimumPayment: 3500 })
    expect(rows.find((r) => r.accountId === car)).toMatchObject({ aprBps: 400, minimumPayment: 40000 })
    await close()
  })

  /**
   * Fractions of a point are the point. Stored as the percentage itself, `5.25` truncates to
   * `5` in an `integer` column — a quarter of a point off a mortgage — and every test that
   * only asserts "APR came back" still passes.
   */
  it('keeps a fractional rate exactly, to the basis point', async () => {
    const { db, close } = await makeTestDb()
    const id = await addAccount(db, 'Mortgage', false)

    await setDebtTerms(db, {
      accountId: id, aprPercent: 6.875, minimumPaymentDollars: 2_412.37, targetPayoff: null,
    })

    const [row] = await db.select().from(debts)
    expect(row.aprBps).toBe(688)
    expect(row.minimumPayment).toBe(241237)
    await close()
  })

  it('refuses an APR or a payment that is negative or not a number', async () => {
    const { db, close } = await makeTestDb()
    const id = await addAccount(db, 'Car Loan', false)
    const ok = { accountId: id, aprPercent: 5.25, minimumPaymentDollars: 412.5, targetPayoff: null }

    // NaN is what `Number(formData.get('apr'))` yields for an empty or junk field; it reaches
    // an integer column as an unhelpful driver error rather than a message anyone can act on.
    await expect(setDebtTerms(db, { ...ok, aprPercent: Number.NaN })).rejects.toThrow(/APR/i)
    await expect(setDebtTerms(db, { ...ok, aprPercent: -5 })).rejects.toThrow(/APR/i)
    await expect(setDebtTerms(db, { ...ok, minimumPaymentDollars: Number.NaN }))
      .rejects.toThrow(/payment/i)
    await expect(setDebtTerms(db, { ...ok, minimumPaymentDollars: -100 }))
      .rejects.toThrow(/payment/i)

    expect(await db.select().from(debts)).toHaveLength(0)
    await close()
  })

  /**
   * Goals append; they are not keyed by name. Unlike a manual asset, whose name *is* its
   * identity inside `netWorthOn`, a goal's name is a label — two holidays saved for are two
   * goals, and collapsing them would silently discard one target.
   */
  it('adds a second goal with the same name rather than replacing the first', async () => {
    const { db, close } = await makeTestDb()
    await addGoal(db, { name: 'Holiday', targetAmountDollars: 3_000, targetDate: null, linkedAccountId: null })
    await addGoal(db, { name: 'Holiday', targetAmountDollars: 5_000, targetDate: null, linkedAccountId: null })

    const rows = await db.select().from(goals)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.targetAmount).sort((a, b) => a - b)).toEqual([300_000, 500_000])
    await close()
  })

  it('refuses a goal with no name or a target that is not a positive amount', async () => {
    const { db, close } = await makeTestDb()
    const ok = { name: 'Emergency fund', targetAmountDollars: 15_000, targetDate: null, linkedAccountId: null }

    await expect(addGoal(db, { ...ok, name: '   ' })).rejects.toThrow(/name/i)
    // Zero is the denominator of the progress percentage this page renders, and a goal that is
    // met the moment it is created. Negative and NaN are junk input straight from the form.
    await expect(addGoal(db, { ...ok, targetAmountDollars: 0 })).rejects.toThrow(/target/i)
    await expect(addGoal(db, { ...ok, targetAmountDollars: -100 })).rejects.toThrow(/target/i)
    await expect(addGoal(db, { ...ok, targetAmountDollars: Number.NaN })).rejects.toThrow(/target/i)

    expect(await db.select().from(goals)).toHaveLength(0)
    await close()
  })
})

describe('loadDebtsAndGoals', () => {
  it('lists liability accounts with their latest balance and terms', async () => {
    const { db, close } = await makeTestDb()
    const car = await addAccount(db, 'Car Loan', false)
    await snapshot(db, car, '2026-01-01', 12_000_00)
    await snapshot(db, car, '2026-03-01', 9_400_00)
    await setDebtTerms(db, {
      accountId: car, aprPercent: 5.25, minimumPaymentDollars: 412.5, targetPayoff: '2029-06-01',
    })

    const { debts: listed } = await loadDebtsAndGoals(db)

    expect(listed).toEqual([{
      accountId: car,
      name: 'Car Loan',
      // March, not January: the most recent snapshot, not the first row Postgres hands back.
      balance: 9_400_00,
      terms: { aprBps: 525, minimumPayment: 41250, targetPayoff: '2029-06-01' },
    }])
    await close()
  })

  /** An asset account has no APR and no minimum payment; offering it a terms form invites one. */
  it('leaves asset accounts off the debt list but offers them to the goal form', async () => {
    const { db, close } = await makeTestDb()
    const savings = await addAccount(db, 'Savings', true)
    const card = await addAccount(db, 'Credit Card', false)

    const { debts: listed, accountOptions } = await loadDebtsAndGoals(db)

    expect(listed.map((d) => d.name)).toEqual(['Credit Card'])
    // Broadened from the plan, which offered liabilities only because Phase 1 had no synced
    // asset accounts when it was written. A savings goal is linked to a savings account.
    expect(accountOptions).toEqual([
      { id: card, name: 'Credit Card' },
      { id: savings, name: 'Savings' },
    ])
    await close()
  })

  /**
   * An account row is written before its first snapshot, and `applySync` is not transactional,
   * so a run that dies in between leaves exactly this. Reported as `0` the page would tell the
   * owner a car loan was paid off.
   */
  it('reports an unsnapshotted account’s balance as unknown, not as zero', async () => {
    const { db, close } = await makeTestDb()
    await addAccount(db, 'Car Loan', false)

    const { debts: listed } = await loadDebtsAndGoals(db)

    expect(listed[0].balance).toBeNull()
    await close()
  })

  it('reports no terms as absent rather than as zero-rate terms', async () => {
    const { db, close } = await makeTestDb()
    const car = await addAccount(db, 'Car Loan', false)
    await snapshot(db, car, '2026-03-01', 9_400_00)

    const [listed] = (await loadDebtsAndGoals(db)).debts

    // A missing APR rendered as 0.00% is a claim the owner borrows for free.
    expect(listed.terms).toBeNull()
    // …and the account itself is still listed, with its balance. A debt with no terms set is
    // the state every debt starts in; dropping it from the list would leave no form to set
    // them with.
    expect(listed.balance).toBe(9_400_00)
    await close()
  })

  it('measures a goal against the latest balance of the account it is linked to', async () => {
    const { db, close } = await makeTestDb()
    const savings = await addAccount(db, 'Savings', true)
    await snapshot(db, savings, '2026-01-01', 2_000_00, true)
    await snapshot(db, savings, '2026-03-01', 6_000_00, true)
    await addGoal(db, {
      name: 'Emergency fund', targetAmountDollars: 15_000, targetDate: '2027-01-01',
      linkedAccountId: savings,
    })

    const [goal] = (await loadDebtsAndGoals(db)).goals

    expect(goal).toMatchObject({
      name: 'Emergency fund',
      saved: 6_000_00,
      targetAmount: 15_000_00,
      targetDate: '2027-01-01',
      linkedAccountId: savings,
    })
    await close()
  })

  /** Unknown progress, not zero progress: nothing here knows what has been saved. */
  it('reports progress as unknown for a goal with no linked account', async () => {
    const { db, close } = await makeTestDb()
    await addGoal(db, {
      name: 'Emergency fund', targetAmountDollars: 15_000, targetDate: null, linkedAccountId: null,
    })

    const [goal] = (await loadDebtsAndGoals(db)).goals

    expect(goal.saved).toBeNull()
    expect(goal.targetAmount).toBe(15_000_00)
    await close()
  })

  it('is empty on a fresh install', async () => {
    const { db, close } = await makeTestDb()
    expect(await loadDebtsAndGoals(db)).toEqual({ debts: [], goals: [], accountOptions: [] })
    await close()
  })
})
