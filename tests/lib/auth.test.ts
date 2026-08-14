import { describe, it, expect, beforeEach } from 'vitest'
import { isAllowedEmail, ownerEmail } from '@/lib/auth'

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

/**
 * One decoder for the session token, shared by the middleware and by the dashboard page, so
 * that the shape of a Clerk claim is asserted in exactly one place. Two copies of a
 * security-relevant cast drift; one copy is testable against the shapes Clerk can actually
 * produce.
 */
describe('ownerEmail', () => {
  it('returns the address when the claim is the allowlisted owner', () => {
    expect(ownerEmail({ email: 'owner@example.com' })).toBe('owner@example.com')
  })

  it('returns the claim as the token stated it, not a normalised copy', () => {
    // Trimming and case-folding belong to the comparison, not to the value handed back.
    expect(ownerEmail({ email: ' OWNER@Example.com ' })).toBe(' OWNER@Example.com ')
  })

  it('returns null for a signed-in identity that is not the owner', () => {
    expect(ownerEmail({ email: 'someone@else.com' })).toBeNull()
  })

  it('returns null when the email claim is missing', () => {
    // The default Clerk session token has no `email` claim at all: it must be added in the
    // dashboard. Absent the claim this denies everyone, which is the safe failure.
    expect(ownerEmail({ sub: 'user_123' })).toBeNull()
    expect(ownerEmail({})).toBeNull()
  })

  it('returns null when there are no claims at all', () => {
    // `sessionClaims` is null when signed out.
    expect(ownerEmail(null)).toBeNull()
    expect(ownerEmail(undefined)).toBeNull()
  })

  it('returns null, rather than throwing, when the email claim is not a string', () => {
    // A claim template like `{{user.email_addresses}}` yields an array, and a hand-written
    // one can yield anything. Reaching `.trim()` on it would throw a TypeError inside the
    // middleware — fail-closed, but as a 500 rather than a decision.
    expect(ownerEmail({ email: ['owner@example.com'] })).toBeNull()
    expect(ownerEmail({ email: { address: 'owner@example.com' } })).toBeNull()
    expect(ownerEmail({ email: 42 })).toBeNull()
    expect(ownerEmail({ email: null })).toBeNull()
  })

  it('returns null for a primitive or a string where an object was expected', () => {
    expect(ownerEmail('owner@example.com')).toBeNull()
    expect(ownerEmail(42)).toBeNull()
  })

  it('fails closed when ALLOWED_EMAIL is unset, even for a well-formed claim', () => {
    delete process.env.ALLOWED_EMAIL
    expect(ownerEmail({ email: 'owner@example.com' })).toBeNull()
  })
})
