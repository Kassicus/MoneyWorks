import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeAccountsResponse, fetchAccounts } from '@/sync/simplefin'
import fixture from '../fixtures/simplefin-accounts.json'

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

  it('converts posted epoch seconds to an ISO date', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-1')!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('links each transaction to its account', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-2')!.simplefinAccountId).toBe('acct-visa')
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
})
