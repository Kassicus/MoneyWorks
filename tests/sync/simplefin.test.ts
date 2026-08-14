import { describe, it, expect, vi, afterEach } from 'vitest'
import util from 'node:util'
import { normalizeAccountsResponse, fetchAccounts, claimAccessUrl } from '@/sync/simplefin'
import fixture from '../fixtures/simplefin-accounts.json'

/**
 * Everything a caught error could expose to a log line. A credential that survives only in
 * a non-enumerable property still reaches `console.error(err)`, so checking `err.message`
 * alone would let a leak through: `new URL()` throws with a clean message and the whole
 * input in `err.input`.
 */
function serialize(error: unknown): string {
  return [
    String(error),
    (error as Error)?.stack,
    JSON.stringify(error),
    util.inspect(error, { depth: 6 }),
  ].join('\n')
}

describe('normalizeAccountsResponse', () => {
  const { accounts, transactions } = normalizeAccountsResponse(fixture)

  it('converts balances to integer cents', () => {
    expect(accounts.find((a) => a.simplefinId === 'acct-checking')!.balance).toBe(154327)
  })

  it('classifies a negative balance as a liability and stores a positive magnitude', () => {
    const visa = accounts.find((a) => a.simplefinId === 'acct-visa')!
    expect(visa.isAsset).toBe(false)
    expect(visa.balance).toBe(89210)
  })

  it('keeps the natural sign on transaction amounts', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-1')!.amount).toBe(-4550)
  })

  // The exact date, not just a date-shaped string: reading `posted` as milliseconds yields
  // 1970-01-21 and reading it in local time shifts an evening-UTC transaction into the
  // previous day, misfiling it against the wrong daily snapshot. Both pass a shape check.
  it('converts posted epoch seconds to a UTC ISO date', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-1')!.date).toBe('2026-08-06')
  })

  it('links each transaction to its account', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-2')!.simplefinAccountId).toBe('acct-visa')
  })

  // The fixture's own transaction sits at 07:06 UTC, which lands on the same calendar day
  // in most of the Americas — so it cannot tell UTC from local time. These two sit either
  // side of the UTC day boundary: a local-time implementation misfiles the first west of
  // UTC and the second east of it, wherever the test happens to run.
  it('reads posted in UTC on both edges of the day, whatever the host timezone', () => {
    const edges = normalizeAccountsResponse({
      accounts: [
        {
          id: 'acct-edges',
          name: 'Edges',
          balance: '0.00',
          transactions: [
            { id: 'just-after-midnight', posted: 1785976200, amount: '1.00', description: '' },
            { id: 'just-before-midnight', posted: 1786059000, amount: '1.00', description: '' },
          ],
        },
      ],
    })
    expect(edges.transactions.map((t) => t.date)).toEqual(['2026-08-06', '2026-08-06'])
  })

  // A balance that is not a number would classify as a liability (`NaN >= 0` is false) with
  // a NaN balance: an account row whose `isAsset` is inverted, which can outlive the failed
  // snapshot insert depending on the caller's transaction boundary. Refuse it here instead.
  it('refuses an unusable balance, naming the account and not the balance', () => {
    const payload = { accounts: [{ id: 'acct-broken', name: 'Broken', balance: 'MALFORMED' }] }
    expect(() => normalizeAccountsResponse(payload)).toThrow(/acct-broken/)
    expect(() => normalizeAccountsResponse(payload)).not.toThrow(/MALFORMED/)
  })
})

describe('fetchAccounts', () => {
  // A realistic SimpleFIN access URL: the credentials live in the userinfo, and the
  // password is percent-encoded because it contains a character the URL reserves.
  const ACCESS_URL = 'https://demo-user:s3cret%2Fpass@bridge.example.org/simplefin'
  const CREDENTIAL = 's3cret/pass'

  afterEach(() => vi.unstubAllGlobals())

  it('sends the access URL credentials as a header, never in the request URL', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchAccounts(ACCESS_URL, 1786000000)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    // `fetch` rejects any URL carrying credentials, and the TypeError it throws quotes the
    // whole URL — so the credentials have to be gone from the URL before the call.
    expect(String(url)).not.toContain(CREDENTIAL)
    expect(String(url)).not.toContain('s3cret')
    expect(String(url)).not.toContain('@')
    expect(url.searchParams.get('start-date')).toBe('1786000000')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`demo-user:${CREDENTIAL}`).toString('base64')}`,
    )
  })

  it('reports a failed fetch by status without leaking the access URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))

    await expect(fetchAccounts(ACCESS_URL, 1786000000)).rejects.toThrow(/403/)
    await expect(fetchAccounts(ACCESS_URL, 1786000000)).rejects.not.toThrow(/s3cret|demo-user/)
  })

  it('rejects a malformed access URL without carrying it in the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    // `new URL()` rejects this, and its TypeError keeps the whole input in `err.input` —
    // clean `err.message`, credential still one `console.error(err)` away.
    const caught = await fetchAccounts(`not a url ${ACCESS_URL}`, 1786000000).catch((e) => e)

    expect(caught).toBeInstanceOf(Error)
    expect(serialize(caught)).not.toContain('s3cret')
    expect(serialize(caught)).not.toContain('demo-user')
  })

  it('never sends a method: reads from SimpleFIN are GETs', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchAccounts(ACCESS_URL, 1786000000)

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit | undefined]
    expect(init?.method).toBeUndefined()
  })
})

describe('claimAccessUrl', () => {
  const CLAIM_URL = 'https://bridge.example.org/simplefin/claim/demo'
  const token = (claimUrl: string) => Buffer.from(claimUrl, 'utf8').toString('base64')

  afterEach(() => vi.unstubAllGlobals())

  // The one-time claim is the only write this app may ever issue to SimpleFIN. Nothing else
  // in the codebase fails if that stops being true, so it is pinned here.
  it('claims the setup token with the single POST this app is allowed to make', async () => {
    const fetchMock = vi.fn(async () => new Response(`${CLAIM_URL}/access\n`, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const accessUrl = await claimAccessUrl(token(CLAIM_URL))

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL | string, RequestInit]
    expect(String(url)).toBe(CLAIM_URL)
    expect(init.method).toBe('POST')
    expect(accessUrl).toBe(`${CLAIM_URL}/access`) // trailing newline trimmed
  })

  it('rejects a corrupt setup token without echoing what it decoded to', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    // Base64 decoding is lenient, so a corrupt token yields a string, not an error — and
    // `fetch` puts that string straight into its own TypeError message.
    const caught = await claimAccessUrl(token('not a url SETUP-TOKEN-SENTINEL')).catch((e) => e)

    expect(caught).toBeInstanceOf(Error)
    expect(serialize(caught)).not.toContain('SETUP-TOKEN-SENTINEL')
  })
})
