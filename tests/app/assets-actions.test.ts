import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import {
  addManualAsset, revalueManualAsset, latestManualAssets,
} from '@/app/(app)/assets/actions'
import { manualAssets } from '@/db/schema'
import { loadNetWorthInputs } from '@/lib/queries'
import { netWorthOn } from '@/lib/net-worth'

/**
 * Real SQL against a real (PGlite) database throughout: these functions are three statements
 * of composition, so a mocked handle would only assert that drizzle was called the way it was
 * called. Every assertion below is either a row that came back out of Postgres or a net worth
 * figure derived from those rows.
 */

const house = {
  name: 'House', kind: 'property', isAsset: true, valueDollars: 400_000, asOf: '2026-01-01',
}

/**
 * Enough of a pause for `created_at` to advance between two writes.
 *
 * PGlite's `now()` is millisecond-resolution — six back-to-back inserts here span about two
 * milliseconds, several of them sharing a timestamp exactly — so without this the same-day
 * tiebreak tests below assert on a tie they meant to break, and fail roughly one run in five.
 * Nothing about production needs it: real Postgres keeps microseconds, and the two writes in
 * question are two separate form submissions by a human.
 */
const aMomentLater = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('manual assets', () => {
  it('stores a dollar input as integer cents', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, {
      name: 'House', kind: 'property', isAsset: true, valueDollars: 420000, asOf: '2026-01-01',
    })
    const rows = await db.select().from(manualAssets)
    expect(rows[0].value).toBe(42000000)
    await close()
  })

  it('appends a row on revaluation instead of overwriting history', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, {
      name: 'House', kind: 'property', isAsset: true, valueDollars: 400000, asOf: '2026-01-01',
    })
    await revalueManualAsset(db, { name: 'House', valueDollars: 420000, asOf: '2026-07-01' })

    const rows = await db.select().from(manualAssets)
    expect(rows).toHaveLength(2)
    // The pair, not just the values: a revaluation that appended the new figure under the
    // *prior* as-of date would preserve two rows and still rewrite January.
    expect(rows.map((r) => ({ asOf: r.asOf, value: r.value })).sort((a, b) => a.value - b.value))
      .toEqual([
        { asOf: '2026-01-01', value: 40000000 },
        { asOf: '2026-07-01', value: 42000000 },
      ])
    await close()
  })

  // The reason the row is appended rather than updated, stated as the figure the owner sees.
  // An UPDATE would answer 420k for March as well, silently rewriting a settled month.
  it('leaves past net worth alone when an asset is revalued', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, house)
    await revalueManualAsset(db, { name: 'House', valueDollars: 420_000, asOf: '2026-07-01' })

    const { snapshots, manual } = await loadNetWorthInputs(db)
    expect(netWorthOn('2026-03-01', snapshots, manual)).toBe(400_000_00)
    expect(netWorthOn('2026-08-01', snapshots, manual)).toBe(420_000_00)
    // And once, not twice: identity across revaluations is the name, so the two rows are one
    // house. Keyed on the row id they would sum to $820,000.
    await close()
  })

  it('carries kind and the asset/liability sign forward from the prior valuation', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, {
      name: 'Mortgage', kind: 'loan', isAsset: false, valueDollars: 250_000, asOf: '2026-01-01',
    })
    await revalueManualAsset(db, { name: 'Mortgage', valueDollars: 245_000, asOf: '2026-07-01' })

    const rows = await db.select().from(manualAssets)
    // A revaluation that let its caller supply `isAsset` could flip a debt into an asset and
    // move net worth by twice the balance. The signature does not offer the option; this
    // pins that the stored row is not silently re-signed either.
    expect(rows.every((r) => r.isAsset === false && r.kind === 'loan')).toBe(true)

    const { snapshots, manual } = await loadNetWorthInputs(db)
    expect(netWorthOn('2026-08-01', snapshots, manual)).toBe(-245_000_00)
    await close()
  })

  it('refuses to revalue a name that was never added', async () => {
    const { db, close } = await makeTestDb()
    await expect(
      revalueManualAsset(db, { name: 'Boat', valueDollars: 10_000, asOf: '2026-07-01' }),
    ).rejects.toThrow(/Boat/)
    // Nothing invented: a revaluation is not a back door into creating an asset with no kind
    // and no asset/liability sign.
    expect(await db.select().from(manualAssets)).toHaveLength(0)
    await close()
  })

  /**
   * The guard that makes name-as-identity sound.
   *
   * `netWorthOn` groups manual valuations by `name` so that revaluing a house does not count
   * two houses. The cost of that choice is that two *genuinely different* assets sharing a
   * name merge into one — the older one stops contributing to net worth entirely, silently.
   * A unique index cannot express this, because revaluations legitimately produce many rows
   * with one name, so the constraint lives here: unique at creation, unlimited thereafter.
   */
  it('refuses a second asset whose name is already in use', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, {
      name: 'Car', kind: 'vehicle', isAsset: true, valueDollars: 20_000, asOf: '2026-01-01',
    })

    await expect(addManualAsset(db, {
      name: 'Car', kind: 'vehicle', isAsset: true, valueDollars: 8_000, asOf: '2026-01-01',
    })).rejects.toThrow(/already exists/)

    expect(await db.select().from(manualAssets)).toHaveLength(1)

    // The harm the guard prevents, priced: without it both cars are stored, `netWorthOn`
    // groups them under one name, and the $20,000 car vanishes from net worth.
    const { snapshots, manual } = await loadNetWorthInputs(db)
    expect(netWorthOn('2026-08-01', snapshots, manual)).toBe(20_000_00)
    await close()
  })

  it('refuses a name that differs only by case or by whitespace', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, { ...house, name: 'My House' })

    // Distinct strings, so these would *not* merge — they would sit in the list looking
    // identical, and a revaluation would land on whichever one the owner happened to pick,
    // leaving the other frozen at its old figure inside net worth forever. `My  House` is in
    // the list because HTML collapses the double space: on the page it is the same two words.
    for (const name of ['my house', 'MY HOUSE', ' My House', 'My House ', 'My  House']) {
      await expect(addManualAsset(db, { ...house, name })).rejects.toThrow(/already exists/)
    }
    expect(await db.select().from(manualAssets)).toHaveLength(1)
    await close()
  })

  it('stores the name as it renders, and refuses one that is blank', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, { ...house, name: '  My  House  ' })
    const [row] = await db.select().from(manualAssets)
    expect(row.name).toBe('My House')

    // There is no delete and no rename, so an unnamed row would be permanent.
    await expect(addManualAsset(db, { ...house, name: '   ' })).rejects.toThrow(/name/i)
    expect(await db.select().from(manualAssets)).toHaveLength(1)
    await close()
  })

  it('refuses a value that is negative or not a number', async () => {
    const { db, close } = await makeTestDb()
    // Liabilities are a positive magnitude that net worth subtracts. A negative asset is that
    // same debt entered with the sign applied twice, and it is permanent in an append-only
    // store. NaN is what `Number(formData.get('value'))` yields for junk input.
    await expect(addManualAsset(db, { ...house, valueDollars: -400_000 }))
      .rejects.toThrow(/value/i)
    await expect(addManualAsset(db, { ...house, valueDollars: Number.NaN }))
      .rejects.toThrow(/value/i)

    await addManualAsset(db, house)
    await expect(revalueManualAsset(db, { name: 'House', valueDollars: -1, asOf: '2026-07-01' }))
      .rejects.toThrow(/value/i)
    expect(await db.select().from(manualAssets)).toHaveLength(1)
    await close()
  })

  it('accepts the name in whatever case the owner typed, and stores the canonical one', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, house)
    await revalueManualAsset(db, { name: ' hOuSe ', valueDollars: 420_000, asOf: '2026-07-01' })

    const rows = await db.select().from(manualAssets)
    // Both rows carry the name as it was created. Inserting the caller's spelling instead
    // would split one house into two identities and double-count it.
    expect(rows.map((r) => r.name)).toEqual(['House', 'House'])
    const { snapshots, manual } = await loadNetWorthInputs(db)
    expect(netWorthOn('2026-08-01', snapshots, manual)).toBe(420_000_00)
    await close()
  })

  it('supersedes a same-day valuation by insertion time, not by input order', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, house)
    await aMomentLater()
    // Valued in the morning, corrected in the afternoon: two rows with the same as-of date.
    // `created_at` is the only thing that can separate them, which is why the insert leaves
    // it to the column default rather than setting or copying one.
    await revalueManualAsset(db, { name: 'House', valueDollars: 405_000, asOf: '2026-01-01' })

    const rows = await db.select().from(manualAssets)
    expect(rows).toHaveLength(2)
    expect(rows[0].createdAt.getTime()).not.toBe(rows[1].createdAt.getTime())

    const { snapshots, manual } = await loadNetWorthInputs(db)
    expect(netWorthOn('2026-01-01', snapshots, manual)).toBe(405_000_00)
    await close()
  })
})

describe('latestManualAssets', () => {
  it('returns one entry per asset, holding its most recent valuation', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, house)
    await revalueManualAsset(db, { name: 'House', valueDollars: 420_000, asOf: '2026-07-01' })
    await addManualAsset(db, {
      name: 'Mortgage', kind: 'loan', isAsset: false, valueDollars: 250_000, asOf: '2026-02-01',
    })

    expect(await latestManualAssets(db)).toEqual([
      { name: 'House', kind: 'property', isAsset: true, value: 420_000_00, asOf: '2026-07-01' },
      { name: 'Mortgage', kind: 'loan', isAsset: false, value: 250_000_00, asOf: '2026-02-01' },
    ])
    await close()
  })

  it('picks the later insertion when two valuations share an as-of date', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, house)
    await aMomentLater()
    await revalueManualAsset(db, { name: 'House', valueDollars: 405_000, asOf: '2026-01-01' })

    const [only] = await latestManualAssets(db)
    // The page must agree with the dashboard about which figure is current, so the tie is
    // broken the same way `netWorthOn` breaks it — by `created_at`, not by row order.
    expect(only.value).toBe(405_000_00)
    await close()
  })

  it('is empty before anything has been added', async () => {
    const { db, close } = await makeTestDb()
    expect(await latestManualAssets(db)).toEqual([])
    await close()
  })
})
