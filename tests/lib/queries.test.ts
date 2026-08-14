import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../helpers/test-db'
import { loadNetWorthInputs, lastSuccessfulSync } from '@/lib/queries'
import { netWorthOn } from '@/lib/net-worth'
import { accounts, balanceSnapshots, manualAssets, syncRuns } from '@/db/schema'

describe('loadNetWorthInputs', () => {
  it('loads snapshots with their own asset flag, and manual assets keyed by name', async () => {
    const { db, close } = await makeTestDb()
    const [a] = await db.insert(accounts)
      .values({ name: 'Visa', type: 'liability', isAsset: false }).returning()
    await db.insert(balanceSnapshots)
      .values({ accountId: a.id, date: '2026-08-13', balance: 50000, isAsset: false })
    await db.insert(manualAssets)
      .values({ name: 'House', kind: 'property', isAsset: true, value: 40000000, asOf: '2026-01-01' })

    const { snapshots, manual } = await loadNetWorthInputs(db)
    expect(snapshots[0]).toMatchObject({ isAsset: false, balance: 50000, date: '2026-08-13' })
    expect(manual[0]).toMatchObject({ name: 'House', isAsset: true, value: 40000000, asOf: '2026-01-01' })
    await close()
  })

  it('returns exactly the fields netWorthOn consumes, with createdAt as an ISO string', async () => {
    const { db, close } = await makeTestDb()
    const [a] = await db.insert(accounts)
      .values({ name: 'Checking', type: 'depository', isAsset: true }).returning()
    await db.insert(balanceSnapshots)
      .values({ accountId: a.id, date: '2026-08-13', balance: 123456, isAsset: true })
    const [m] = await db.insert(manualAssets)
      .values({ name: 'House', kind: 'property', isAsset: true, value: 40000000, asOf: '2026-01-01' })
      .returning()

    const { snapshots, manual } = await loadNetWorthInputs(db)

    // `toEqual`, not `toMatchObject`: selecting whole rows would also drag `manual_assets.id`
    // along, and an id in the payload invites keying on it — which double-counts a revalued
    // house. `createdAt` must be the string ManualAssetValue declares, not drizzle's Date:
    // `latestOnOrBefore` compares it lexicographically, and two Dates compare as "[object
    // Date]" === "[object Date]", silently losing every same-day tiebreak.
    expect(snapshots).toEqual([
      { accountId: a.id, date: '2026-08-13', balance: 123456, isAsset: true },
    ])
    expect(manual).toEqual([
      {
        name: 'House',
        isAsset: true,
        asOf: '2026-01-01',
        value: 40000000,
        createdAt: m.createdAt.toISOString(),
      },
    ])
    await close()
  })

  it('keeps a past snapshot signed as it was, even after the account flips to an asset', async () => {
    // The regression guard for reading `isAsset` off `accounts` via a join. A credit card
    // overpaid into credit — or a checking account overdrawn — flips `accounts.is_asset`
    // today. Sourcing the sign from the account row would re-sign every past snapshot with
    // it, moving net worth on 2026-08-01 by twice the balance and rewriting history that
    // the owner has already read.
    const { db, close } = await makeTestDb()
    const [card] = await db.insert(accounts)
      .values({ name: 'Visa', type: 'liability', isAsset: false }).returning()
    await db.insert(balanceSnapshots)
      .values({ accountId: card.id, date: '2026-08-01', balance: 500_00, isAsset: false })

    // The card is overpaid: the next sync upserts the account as an asset and writes a new
    // snapshot that says so. Exactly what `applySync` does.
    await db.update(accounts).set({ isAsset: true }).where(eq(accounts.id, card.id))
    await db.insert(balanceSnapshots)
      .values({ accountId: card.id, date: '2026-08-02', balance: 25_00, isAsset: true })

    const { snapshots, manual } = await loadNetWorthInputs(db)

    const aug1 = snapshots.find((s) => s.date === '2026-08-01')
    expect(aug1?.isAsset).toBe(false)
    // The consequence, not just the flag: a $500 debt on 2026-08-01 stays a $500 debt.
    expect(netWorthOn('2026-08-01', snapshots, manual)).toBe(-500_00)
    expect(netWorthOn('2026-08-02', snapshots, manual)).toBe(25_00)
    await close()
  })

  it('carries createdAt through so a same-day revaluation resolves on the data', async () => {
    const { db, close } = await makeTestDb()
    // Valued in the morning, corrected in the afternoon: same name, same as_of, two rows.
    await db.insert(manualAssets).values({
      name: 'House', kind: 'property', isAsset: true, value: 400_000_00, asOf: '2026-08-01',
      createdAt: new Date('2026-08-01T15:00:00Z'),
    })
    await db.insert(manualAssets).values({
      name: 'House', kind: 'property', isAsset: true, value: 380_000_00, asOf: '2026-08-01',
      createdAt: new Date('2026-08-01T09:00:00Z'),
    })

    const { snapshots, manual } = await loadNetWorthInputs(db)

    // Two rows for one house, and the afternoon correction is NOT the last row in query
    // order — so only a real `createdAt` can pick it. Without one the answer would depend
    // on whatever ORDER BY this query happens to have.
    expect(manual).toHaveLength(2)
    expect(netWorthOn('2026-08-01', snapshots, manual)).toBe(400_000_00)
    await close()
  })

  it('returns empty inputs on a database with nothing in it', async () => {
    const { db, close } = await makeTestDb()
    const { snapshots, manual } = await loadNetWorthInputs(db)
    expect(snapshots).toEqual([])
    expect(manual).toEqual([])
    // The dashboard renders $0.00, not a crash, before the first sync.
    expect(netWorthOn('2026-08-13', snapshots, manual)).toBe(0)
    await close()
  })
})

describe('lastSuccessfulSync', () => {
  it('returns the most recent successful sync time, ignoring failures', async () => {
    const { db, close } = await makeTestDb()
    await db.insert(syncRuns).values({ status: 'ok', finishedAt: new Date('2026-08-10T09:00:00Z') })
    await db.insert(syncRuns).values({ status: 'error', finishedAt: new Date('2026-08-13T09:00:00Z') })

    const at = await lastSuccessfulSync(db)
    expect(at?.toISOString()).toBe('2026-08-10T09:00:00.000Z')
    await close()
  })

  it('returns null when no sync has ever succeeded', async () => {
    const { db, close } = await makeTestDb()
    expect(await lastSuccessfulSync(db)).toBeNull()
    await close()
  })

  it('returns the latest of several successful syncs, not the earliest', async () => {
    const { db, close } = await makeTestDb()
    // Inserted newest-first, so "the last row" and "the first row" are both wrong answers.
    await db.insert(syncRuns).values({ status: 'ok', finishedAt: new Date('2026-08-12T09:00:00Z') })
    await db.insert(syncRuns).values({ status: 'ok', finishedAt: new Date('2026-08-10T09:00:00Z') })

    const at = await lastSuccessfulSync(db)
    expect(at?.toISOString()).toBe('2026-08-12T09:00:00.000Z')
    await close()
  })

  it('ignores a run with no finish time, which sorts first under DESC in Postgres', async () => {
    const { db, close } = await makeTestDb()
    await db.insert(syncRuns).values({ status: 'ok', finishedAt: new Date('2026-08-10T09:00:00Z') })
    // `ORDER BY finished_at DESC` puts NULLs *first* in Postgres, so an unfinished row would
    // be picked and `lastSuccessfulSync` would answer null — "never synced" — while a good
    // sync sits in the table. The banner would then tell the owner their cron is broken.
    await db.insert(syncRuns).values({ status: 'ok', finishedAt: null })

    const at = await lastSuccessfulSync(db)
    expect(at?.toISOString()).toBe('2026-08-10T09:00:00.000Z')
    await close()
  })
})
