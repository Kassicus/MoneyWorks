import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { accounts, balanceSnapshots } from '@/db/schema'

describe('schema', () => {
  it('round-trips an account and a balance snapshot in integer cents', async () => {
    const { db, close } = await makeTestDb()
    const [acct] = await db.insert(accounts)
      .values({ name: 'Checking', type: 'checking', isAsset: true })
      .returning()

    await db.insert(balanceSnapshots)
      .values({ accountId: acct.id, date: '2026-08-13', balance: 123456 })

    const rows = await db.select().from(balanceSnapshots)
    expect(rows).toHaveLength(1)
    expect(rows[0].balance).toBe(123456)
    expect(typeof rows[0].balance).toBe('number')
    await close()
  })
})
