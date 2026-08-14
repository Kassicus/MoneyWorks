import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { accounts, balanceSnapshots, secrets } from '@/db/schema'

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
