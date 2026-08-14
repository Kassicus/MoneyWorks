import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { makeTestDb } from '../helpers/test-db'
import { putSecret, getSecret } from '@/lib/secrets'
import { secrets } from '@/db/schema'

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

describe('secrets store', () => {
  it('stores a value encrypted and reads it back', async () => {
    const { db, close } = await makeTestDb()
    try {
      await putSecret(db, 'simplefin_access_url', 'https://example.test/accounts')

      const raw = await db.select().from(secrets)
      expect(raw[0].ciphertext.toString('utf8')).not.toContain('example.test')

      expect(await getSecret(db, 'simplefin_access_url')).toBe('https://example.test/accounts')
    } finally {
      await close()
    }
  })

  it('overwrites an existing key', async () => {
    const { db, close } = await makeTestDb()
    try {
      await putSecret(db, 'k', 'first')
      await putSecret(db, 'k', 'second')
      expect(await getSecret(db, 'k')).toBe('second')
    } finally {
      await close()
    }
  })

  it('returns null for a missing key', async () => {
    const { db, close } = await makeTestDb()
    try {
      expect(await getSecret(db, 'nope')).toBeNull()
    } finally {
      await close()
    }
  })
})
