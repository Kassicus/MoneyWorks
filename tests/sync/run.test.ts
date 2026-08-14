import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { applySync } from '@/sync/run'
import { accounts, balanceSnapshots, transactions } from '@/db/schema'
import fixture from '../fixtures/simplefin-accounts.json'

describe('applySync', () => {
  it('inserts accounts, transactions, and one snapshot per account', async () => {
    const { db, close } = await makeTestDb()
    try {
      await applySync(db, fixture, '2026-08-13')

      expect(await db.select().from(accounts)).toHaveLength(2)
      expect(await db.select().from(transactions)).toHaveLength(2)
      expect(await db.select().from(balanceSnapshots)).toHaveLength(2)
    } finally {
      await close()
    }
  })

  it('is idempotent: running the same payload twice creates no duplicates', async () => {
    const { db, close } = await makeTestDb()
    try {
      await applySync(db, fixture, '2026-08-13')
      await applySync(db, fixture, '2026-08-13')

      expect(await db.select().from(accounts)).toHaveLength(2)
      expect(await db.select().from(transactions)).toHaveLength(2)
      expect(await db.select().from(balanceSnapshots)).toHaveLength(2)
    } finally {
      await close()
    }
  })

  it('writes a new snapshot row on a new date, keeping the old one', async () => {
    const { db, close } = await makeTestDb()
    try {
      await applySync(db, fixture, '2026-08-13')
      await applySync(db, fixture, '2026-08-14')

      expect(await db.select().from(balanceSnapshots)).toHaveLength(4)
    } finally {
      await close()
    }
  })

  it('updates a snapshot in place when the balance changes on the same date', async () => {
    const { db, close } = await makeTestDb()
    try {
      await applySync(db, fixture, '2026-08-13')

      const revised = structuredClone(fixture)
      revised.accounts[0].balance = '2000.00'
      await applySync(db, revised, '2026-08-13')

      // By account, not `some`: a revision that landed on the *other* account's snapshot
      // satisfies "some row reads 200000" while putting the checking balance on the card.
      const checking = (await db.select().from(accounts))
        .find((a) => a.simplefinId === 'acct-checking')!
      const rows = await db.select().from(balanceSnapshots)
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.accountId === checking.id)!.balance).toBe(200000)
    } finally {
      await close()
    }
  })

  // Counting rows cannot tell a snapshot written against the right account from one written
  // against the wrong one, nor a liability stored as a positive magnitude from one stored
  // signed — and either is a silently wrong number on the dashboard, not a crash. The
  // account ids are generated, so the only way to check the wiring is through the map
  // `applySync` builds from the upsert's `returning()`.
  it('files each snapshot and transaction against its own account, liabilities positive', async () => {
    const { db, close } = await makeTestDb()
    try {
      await applySync(db, fixture, '2026-08-13')

      const accountRows = await db.select().from(accounts)
      const checking = accountRows.find((a) => a.simplefinId === 'acct-checking')!
      const visa = accountRows.find((a) => a.simplefinId === 'acct-visa')!
      const snapshots = await db.select().from(balanceSnapshots)
      const txns = await db.select().from(transactions)

      expect(snapshots.find((s) => s.accountId === checking.id)!.balance).toBe(154327)
      // Stored as a positive magnitude: `netWorthOn` negates every non-asset, so a signed
      // -89210 here would add the card's debt to net worth instead of subtracting it.
      expect(snapshots.find((s) => s.accountId === visa.id)!.balance).toBe(89210)
      expect(visa.isAsset).toBe(false)
      expect(checking.isAsset).toBe(true)
      // Synced accounts are not manual: Task 7's manual assets are the ones this run must
      // never touch, and `manual` is what tells them apart.
      expect(checking.manual).toBe(false)

      const coffee = txns.find((t) => t.simplefinId === 'txn-1')!
      expect(coffee.accountId).toBe(checking.id)
      expect(coffee.amount).toBe(-4550) // signed: money leaving
      expect(coffee.date).toBe('2026-08-06')
      expect(txns.find((t) => t.simplefinId === 'txn-2')!.accountId).toBe(visa.id)
    } finally {
      await close()
    }
  })

  // The three upsert policies are deliberately different, and re-running the same payload
  // cannot tell them apart: a posted transaction is immutable, so re-seeing it must not
  // rewrite it. Swapping this one to `onConflictDoUpdate` passes every other test here.
  it('leaves a posted transaction as first recorded when it comes back revised', async () => {
    const { db, close } = await makeTestDb()
    try {
      await applySync(db, fixture, '2026-08-13')

      const revised = structuredClone(fixture)
      revised.accounts[0].transactions[0].amount = '-999.99'
      revised.accounts[0].transactions[0].description = 'REWRITTEN UPSTREAM'
      await applySync(db, revised, '2026-08-13')

      const rows = await db.select().from(transactions)
      expect(rows).toHaveLength(2)
      const coffee = rows.find((t) => t.simplefinId === 'txn-1')!
      expect(coffee.amount).toBe(-4550)
      expect(coffee.description).toBe('COFFEE ROASTERS')
    } finally {
      await close()
    }
  })

  // The other half of that asymmetry: an account's name and classification *do* change
  // upstream — a card paid off and reported positive is no longer a liability — and the
  // refresh must land on the existing row rather than a second one.
  it('refreshes an account name and classification in place when they change upstream', async () => {
    const { db, close } = await makeTestDb()
    try {
      await applySync(db, fixture, '2026-08-13')
      const [before] = (await db.select().from(accounts))
        .filter((a) => a.simplefinId === 'acct-visa')

      const revised = structuredClone(fixture)
      revised.accounts[1].name = 'Visa Signature (Closed)'
      revised.accounts[1].balance = '25.00' // paid off and in credit: no longer a liability
      await applySync(db, revised, '2026-08-13')

      const rows = await db.select().from(accounts)
      expect(rows).toHaveLength(2)
      const visa = rows.find((a) => a.simplefinId === 'acct-visa')!
      expect(visa.id).toBe(before.id) // same row, not a replacement
      expect(visa.name).toBe('Visa Signature (Closed)')
      expect(visa.isAsset).toBe(true)
      expect(visa.type).toBe('asset')
      // Same date, so this revises the day's existing snapshot — and a revised balance can
      // change what the balance *means*, so both fields have to move together. Updating
      // only `balance` would leave today reading 25.00 of debt.
      const snapshot = (await db.select().from(balanceSnapshots))
        .find((s) => s.accountId === visa.id && s.date === '2026-08-13')!
      expect(snapshot.balance).toBe(2500)
      expect(snapshot.isAsset).toBe(true)
    } finally {
      await close()
    }
  })

  // The account's classification is current state; a snapshot is a historical record, and a
  // historical record must not change meaning when current state does. `netWorthOn` negates
  // every non-asset row, so if the sign came from the account, a card refunded into credit
  // would flip `isAsset` and retroactively *add* every past balance it used to subtract —
  // an $1,784.20 swing on every historical date for this fixture, with nothing crashing.
  // Hence the snapshot carries its own `isAsset`, frozen at write time.
  it('freezes each snapshot classification, so a later flip does not re-sign history', async () => {
    const { db, close } = await makeTestDb()
    try {
      await applySync(db, fixture, '2026-08-13') // acct-visa owes 892.10

      const paidOff = structuredClone(fixture)
      paidOff.accounts[1].balance = '50.00' // refunded past zero: now in credit
      await applySync(db, paidOff, '2026-08-20')

      const visa = (await db.select().from(accounts))
        .find((a) => a.simplefinId === 'acct-visa')!
      const history = (await db.select().from(balanceSnapshots))
        .filter((s) => s.accountId === visa.id)
        .sort((a, b) => a.date.localeCompare(b.date))

      expect(visa.isAsset).toBe(true) // present classification follows the present balance
      expect(history).toEqual([
        { accountId: visa.id, date: '2026-08-13', balance: 89210, isAsset: false },
        { accountId: visa.id, date: '2026-08-20', balance: 5000, isAsset: true },
      ])
    } finally {
      await close()
    }
  })

  // Task 8 records these counts as the outcome of the run; nothing else in the suite reads
  // the return value, so a zero or a swapped pair would go unnoticed.
  it('reports how many accounts and transactions the payload carried', async () => {
    const { db, close } = await makeTestDb()
    try {
      const oneAccount = { accounts: [structuredClone(fixture).accounts[0]] }
      expect(await applySync(db, oneAccount, '2026-08-13')).toEqual({
        accounts: 1,
        transactions: 1,
      })
      expect(await applySync(db, fixture, '2026-08-13')).toEqual({
        accounts: 2,
        transactions: 2,
      })
    } finally {
      await close()
    }
  })
})
