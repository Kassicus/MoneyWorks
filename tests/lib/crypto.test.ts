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

  /**
   * GCM permits tags shorter than 128 bits, and Node's default is to accept whatever length
   * `setAuthTag` is handed and verify only that much. A 4-byte tag is one in 2^32 to forge
   * by trial; a 16-byte one is not reachable. The tag arrives from the database row being
   * decrypted, which is precisely where a tampered one would come from, so the length is
   * fixed at the cipher rather than trusted from the input.
   */
  it('refuses a truncated auth tag instead of verifying only its first bytes', () => {
    const parts = encrypt('secret')
    expect(parts.authTag.length).toBe(16)

    const truncated = { ...parts, authTag: parts.authTag.subarray(0, 4) }

    expect(() => decrypt(truncated)).toThrow(/Invalid authentication tag length/i)
  })
})
