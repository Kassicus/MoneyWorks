import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../helpers/test-db'
import { accounts, balanceSnapshots } from '@/db/schema'
import type { Db } from '@/db/types'

/**
 * These three helpers take `db: Db` — the union of the Neon and PGlite clients — on
 * purpose. Every later task writes functions with exactly this signature, so this file
 * is the guard for the union: if it ever stops supporting one of these operations, the
 * typecheck fails here rather than in whichever task happens to reach it first.
 *
 * Scope is deliberately limited to the operations later tasks actually use:
 * insert-with-returning, select-with-where, and the snapshot upsert.
 */

async function createAccount(db: Db, name: string) {
  const [row] = await db.insert(accounts)
    .values({ name, type: 'checking', isAsset: true })
    .returning()
  return row
}

async function upsertSnapshot(db: Db, accountId: string, date: string, balance: number) {
  await db.insert(balanceSnapshots)
    .values({ accountId, date, balance })
    .onConflictDoUpdate({
      target: [balanceSnapshots.accountId, balanceSnapshots.date],
      set: { balance },
    })
}

async function snapshotsFor(db: Db, accountId: string) {
  return db.select().from(balanceSnapshots).where(eq(balanceSnapshots.accountId, accountId))
}

describe('Db handle', () => {
  it('supports insert-returning, select-where, and snapshot upsert through the union type', async () => {
    const { db, close } = await makeTestDb()
    try {
      const acct = await createAccount(db, 'Savings')
      expect(acct.id).toEqual(expect.any(String))

      await upsertSnapshot(db, acct.id, '2026-08-13', 100_00)
      await upsertSnapshot(db, acct.id, '2026-08-13', 250_00)

      const rows = await snapshotsFor(db, acct.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].balance).toBe(250_00)
    } finally {
      await close()
    }
  })

  it('scopes select-where to the requested account', async () => {
    const { db, close } = await makeTestDb()
    try {
      const checking = await createAccount(db, 'Checking')
      const savings = await createAccount(db, 'Savings')

      await upsertSnapshot(db, checking.id, '2026-08-13', 100_00)
      await upsertSnapshot(db, savings.id, '2026-08-13', 900_00)

      const rows = await snapshotsFor(db, savings.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].balance).toBe(900_00)
    } finally {
      await close()
    }
  })
})
