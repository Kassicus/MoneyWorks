import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { accounts, balanceSnapshots, manualAssets, secrets } from '@/db/schema'

/**
 * The name of the constraint a rejected write violated.
 *
 * Drizzle wraps a driver error in one of its own whose `message` is the failing SQL and its
 * bound parameters; the Postgres message — the part that says *which* constraint — is on
 * `cause`. Asserting on the wrapper would pass for any failed insert, including a typo.
 */
async function rejection(write: PromiseLike<unknown>): Promise<string> {
  const err = await Promise.resolve(write).then(() => null, (e: unknown) => e)
  if (!err) throw new Error('Expected the write to be rejected, but it succeeded.')
  return String((err as { cause?: unknown }).cause ?? err)
}

describe('schema', () => {
  it('round-trips an account and a balance snapshot in integer cents', async () => {
    const { db, close } = await makeTestDb()
    try {
      const [acct] = await db.insert(accounts)
        .values({ name: 'Checking', type: 'checking', isAsset: true })
        .returning()

      await db.insert(balanceSnapshots)
        .values({ accountId: acct.id, date: '2026-08-13', balance: 123456, isAsset: true })

      const rows = await db.select().from(balanceSnapshots)
      expect(rows).toHaveLength(1)
      expect(rows[0].balance).toBe(123456)
      expect(typeof rows[0].balance).toBe('number')
      // The snapshot carries its own sign. `balance` is an unsigned magnitude, so a row
      // that had to ask `accounts` what it meant would change meaning whenever the account
      // was reclassified — retroactively re-signing history.
      expect(rows[0].isAsset).toBe(true)
    } finally {
      await close()
    }
  })

  /**
   * The positive-magnitude invariant, enforced by the database rather than by whoever
   * remembers it.
   *
   * `netWorthOn` negates every row whose `is_asset` is false, so a stored negative turns a
   * $400 debt into a $400 asset — an $800 error that raises no exception and prints nothing
   * odd. Before this constraint the only thing holding the rule was `Math.abs()` on one line
   * of `sync/simplefin.ts`, with three modules reading the rows and none re-checking.
   */
  it('refuses a negative balance snapshot', async () => {
    const { db, close } = await makeTestDb()
    try {
      const [acct] = await db.insert(accounts)
        .values({ name: 'Visa', type: 'liability', isAsset: false })
        .returning()

      expect(await rejection(db.insert(balanceSnapshots).values({
        accountId: acct.id, date: '2026-08-13', balance: -89210, isAsset: false,
      }))).toMatch(/violates check constraint "balance_snapshots_balance_non_negative"/)

      // The same debt, stored the way the app stores it: a positive magnitude that
      // `is_asset: false` tells net worth to subtract.
      await db.insert(balanceSnapshots).values({
        accountId: acct.id, date: '2026-08-13', balance: 89210, isAsset: false,
      })
      expect((await db.select().from(balanceSnapshots))[0].balance).toBe(89210)
    } finally {
      await close()
    }
  })

  it('refuses a negative manual asset value', async () => {
    const { db, close } = await makeTestDb()
    try {
      expect(await rejection(db.insert(manualAssets).values({
        name: 'Mortgage', kind: 'loan', isAsset: false, value: -250_000_00, asOf: '2026-02-01',
      }))).toMatch(/violates check constraint "manual_assets_value_non_negative"/)

      // Zero is legitimate and must stay so: a written-off car is worth $0, and revaluing to
      // zero is the only way to say that in an append-only table.
      await db.insert(manualAssets).values({
        name: 'Car', kind: 'vehicle', isAsset: true, value: 0, asOf: '2026-02-01',
      })
      expect((await db.select().from(manualAssets))[0].value).toBe(0)
    } finally {
      await close()
    }
  })

  it('round-trips bytea columns as Buffer', async () => {
    const { db, close } = await makeTestDb()
    try {
      const ciphertext = Buffer.from('deadbeefcafe', 'hex')
      const iv = Buffer.from('000102030405060708090a0b', 'hex')
      const authTag = Buffer.from('0f0e0d0c0b0a09080706050403020100', 'hex')

      await db.insert(secrets).values({ key: 'simplefin_token', ciphertext, iv, authTag })

      const [row] = await db.select().from(secrets)
      // The `bytea` customType annotates these as Buffer. Neon hands back a Buffer but
      // PGlite hands back a Uint8Array, so without a `fromDriver` the annotation is a
      // lie on exactly the driver the tests run on. Task 3 decrypts these columns.
      expect(Buffer.isBuffer(row.ciphertext)).toBe(true)
      expect(Buffer.isBuffer(row.iv)).toBe(true)
      expect(Buffer.isBuffer(row.authTag)).toBe(true)
      expect(row.ciphertext.equals(ciphertext)).toBe(true)
      expect(row.iv.equals(iv)).toBe(true)
      expect(row.authTag.equals(authTag)).toBe(true)
    } finally {
      await close()
    }
  })
})
