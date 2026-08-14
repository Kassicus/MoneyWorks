import { describe, it, expect, beforeEach } from 'vitest'
import { isAllowedEmail } from '@/lib/auth'

beforeEach(() => {
  process.env.ALLOWED_EMAIL = 'Owner@Example.com'
})

describe('isAllowedEmail', () => {
  it('accepts the allowlisted address', () => {
    expect(isAllowedEmail('owner@example.com')).toBe(true)
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(isAllowedEmail('  OWNER@EXAMPLE.COM ')).toBe(true)
  })

  it('trims the env var too, so a stray space cannot lock the owner out', () => {
    process.env.ALLOWED_EMAIL = '  Owner@Example.com\n'
    expect(isAllowedEmail('owner@example.com')).toBe(true)
  })

  it('rejects any other address', () => {
    expect(isAllowedEmail('someone@else.com')).toBe(false)
  })

  it('rejects addresses that merely contain the allowlisted one', () => {
    // Registerable by anyone who controls evil.com, and Clerk allows open sign-up.
    // A prefix or substring comparison would admit it; the match must be exact.
    expect(isAllowedEmail('owner@example.com.evil.com')).toBe(false)
    expect(isAllowedEmail('notowner@example.com')).toBe(false)
  })

  it('rejects null and undefined', () => {
    expect(isAllowedEmail(null)).toBe(false)
    expect(isAllowedEmail(undefined)).toBe(false)
  })

  it('fails closed when ALLOWED_EMAIL is unset', () => {
    delete process.env.ALLOWED_EMAIL
    expect(isAllowedEmail('owner@example.com')).toBe(false)
  })

  it('fails closed when ALLOWED_EMAIL is empty or only whitespace', () => {
    process.env.ALLOWED_EMAIL = ''
    expect(isAllowedEmail('owner@example.com')).toBe(false)

    // A blank allowlist must never match a blank claim.
    process.env.ALLOWED_EMAIL = '   '
    expect(isAllowedEmail('   ')).toBe(false)
  })
})
