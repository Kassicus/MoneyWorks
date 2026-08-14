import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encrypt, decrypt } from '@/lib/crypto'

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

describe('crypto', () => {
  it('round-trips a secret', () => {
    const parts = encrypt('https://user:pass@bridge.simplefin.org/accounts')
    expect(decrypt(parts)).toBe('https://user:pass@bridge.simplefin.org/accounts')
  })

  it('produces a distinct IV per call', () => {
    expect(encrypt('same').iv.equals(encrypt('same').iv)).toBe(false)
  })

  it('rejects tampered ciphertext', () => {
    const parts = encrypt('secret')
    parts.ciphertext[0] ^= 0xff
    // Matching the message pins this to GCM's auth-tag check. A bare `toThrow()` would
    // also pass if decrypt broke for an unrelated reason (missing key, bad IV length).
    expect(() => decrypt(parts)).toThrow(/unable to authenticate data/i)
  })
})
