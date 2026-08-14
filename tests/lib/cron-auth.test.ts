import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isAuthorizedCronRequest } from '@/lib/cron-auth'

const SECRET = 'a-real-looking-cron-secret-8f2c'
const HEADER = `Bearer ${SECRET}`

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
})

afterEach(() => {
  delete process.env.CRON_SECRET
})

describe('isAuthorizedCronRequest', () => {
  it('accepts the exact header Vercel Cron sends', () => {
    expect(isAuthorizedCronRequest(HEADER)).toBe(true)
  })

  // The one that matters. `authorization !== \`Bearer ${process.env.CRON_SECRET}\`` compares
  // against the string "Bearer undefined" when the variable is missing, so a forgotten env
  // var turns the sync route — the thing that talks to the owner's bank — into a public
  // endpoint with a published password.
  it('fails closed when CRON_SECRET is unset, so `Bearer undefined` is not a password', () => {
    delete process.env.CRON_SECRET

    expect(isAuthorizedCronRequest(`Bearer ${process.env.CRON_SECRET}`)).toBe(false)
    expect(isAuthorizedCronRequest('Bearer undefined')).toBe(false)
    expect(isAuthorizedCronRequest('Bearer ')).toBe(false)
    expect(isAuthorizedCronRequest('Bearer')).toBe(false)
    expect(isAuthorizedCronRequest('')).toBe(false)
    expect(isAuthorizedCronRequest(null)).toBe(false)
  })

  it('fails closed when CRON_SECRET is empty or only whitespace', () => {
    process.env.CRON_SECRET = ''
    expect(isAuthorizedCronRequest('Bearer ')).toBe(false)
    expect(isAuthorizedCronRequest('Bearer undefined')).toBe(false)

    process.env.CRON_SECRET = '   '
    expect(isAuthorizedCronRequest('Bearer    ')).toBe(false)
  })

  it('rejects a request carrying no authorization header at all', () => {
    // `Headers.get` returns null for an absent header — the shape the route passes in.
    expect(isAuthorizedCronRequest(null)).toBe(false)
    expect(isAuthorizedCronRequest(undefined)).toBe(false)
  })

  it('rejects a wrong secret, a prefix of it, and an extension of it', () => {
    expect(isAuthorizedCronRequest('Bearer not-the-secret')).toBe(false)
    expect(isAuthorizedCronRequest(`Bearer ${SECRET.slice(0, -1)}`)).toBe(false)
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}x`)).toBe(false)
  })

  it('rejects the bare secret and other schemes: the whole header must match', () => {
    expect(isAuthorizedCronRequest(SECRET)).toBe(false)
    expect(isAuthorizedCronRequest(`Basic ${SECRET}`)).toBe(false)
    expect(isAuthorizedCronRequest(`Token ${SECRET}`)).toBe(false)
  })

  // Vercel sends `Bearer ` + the env var byte for byte. Nothing normalises the header value
  // in between, so an exact comparison is what makes a legitimate cron request match — and
  // it means neither side may be trimmed or lower-cased to be "helpful".
  it('rejects a lowercase scheme and any surrounding whitespace', () => {
    expect(isAuthorizedCronRequest(`bearer ${SECRET}`)).toBe(false)
    expect(isAuthorizedCronRequest(`BEARER ${SECRET}`)).toBe(false)
    expect(isAuthorizedCronRequest(`Bearer ${SECRET} `)).toBe(false)
    expect(isAuthorizedCronRequest(` Bearer ${SECRET}`)).toBe(false)
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}\n`)).toBe(false)
    expect(isAuthorizedCronRequest(`Bearer  ${SECRET}`)).toBe(false)
  })

  it('matches a secret that itself contains whitespace, rather than trimming it away', () => {
    // If the deployed CRON_SECRET has a stray space, Vercel sends that space too. Trimming
    // either side here would reject the platform's own request and silently stop the sync.
    process.env.CRON_SECRET = ' padded-secret '
    expect(isAuthorizedCronRequest('Bearer  padded-secret ')).toBe(true)
    expect(isAuthorizedCronRequest('Bearer padded-secret')).toBe(false)
  })
})
