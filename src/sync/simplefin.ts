/**
 * The boundary between SimpleFIN and everything this app believes about the owner's money.
 *
 * Two concerns, one file, because they are one concern: talking to SimpleFIN. The HTTP calls
 * are thin — they throw on a non-OK response and that is their whole contract; the caller
 * (the sync route) owns retries, logging, and error recording. `normalizeAccountsResponse`
 * is pure, so the shape of what the rest of the app trusts is testable against a fixture
 * without a network.
 *
 * Read-only: the single POST below, the one-time setup-token claim, is the only write this
 * app ever issues to SimpleFIN, and it must stay that way.
 */

import { dollarsToCents } from '@/lib/money'

/** The subset of SimpleFIN's `/accounts` payload we read. Asserted, not validated. */
type RawTransaction = {
  id: string
  posted: number
  amount: string | number
  description?: string | null
}

type RawAccount = {
  id: string
  name: string
  balance: string | number
  transactions?: RawTransaction[]
}

export type NormalizedAccount = {
  simplefinId: string
  name: string
  type: string
  isAsset: boolean
  balance: number // positive magnitude, integer cents
}

export type NormalizedTransaction = {
  simplefinId: string
  simplefinAccountId: string
  date: string
  amount: number // signed, integer cents
  description: string
}

/** Snapshot dates are UTC dates, so `posted` is read in UTC and never in local time. */
function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

export function normalizeAccountsResponse(json: unknown): {
  accounts: NormalizedAccount[]
  transactions: NormalizedTransaction[]
} {
  const raw = json as { accounts?: RawAccount[] }
  const accounts: NormalizedAccount[] = []
  const transactions: NormalizedTransaction[] = []

  for (const a of raw.accounts ?? []) {
    const signed = dollarsToCents(Number(a.balance))
    // SimpleFIN reports what you owe as a negative balance. We store liabilities
    // as a positive magnitude and let net worth do the subtracting.
    const isAsset = signed >= 0
    accounts.push({
      simplefinId: a.id,
      name: a.name,
      type: isAsset ? 'asset' : 'liability',
      isAsset,
      // Load-bearing: `netWorthOn` negates every non-asset, so a negative balance stored
      // here would turn a debt into an asset — a silently wrong number, not a crash.
      balance: Math.abs(signed),
    })

    for (const t of a.transactions ?? []) {
      transactions.push({
        simplefinId: t.id,
        simplefinAccountId: a.id,
        date: isoDate(t.posted),
        // Unlike a balance, a transaction amount keeps its sign: negative is money leaving.
        amount: dollarsToCents(Number(t.amount)),
        description: t.description ?? '',
      })
    }
  }

  return { accounts, transactions }
}

/** One-time exchange of a setup token for a permanent access URL. */
export async function claimAccessUrl(setupToken: string): Promise<string> {
  const claimUrl = Buffer.from(setupToken, 'base64').toString('utf8')
  const res = await fetch(claimUrl, { method: 'POST' })
  if (!res.ok) throw new Error(`SimpleFIN claim failed: ${res.status}`)
  return (await res.text()).trim()
}

/**
 * Moves any credentials out of `url`'s userinfo and into a basic-auth header, mutating
 * `url` to drop them. Returns the headers to merge, or nothing if the URL carried none.
 *
 * Two reasons this is not optional. `fetch` refuses outright to build a request from a URL
 * containing credentials ("Request cannot be constructed from a URL that includes
 * credentials") — and the TypeError it throws to say so quotes the entire URL, which is
 * how a bank credential ends up in a stack trace. SimpleFIN's access URL always carries
 * them, so the split has to happen before the call, not after it fails.
 *
 * `URL` returns userinfo percent-encoded; the credential is the decoded form.
 */
function takeBasicAuth(url: URL): { Authorization: string } | undefined {
  if (!url.username && !url.password) return undefined
  const raw = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  url.username = ''
  url.password = ''
  return { Authorization: `Basic ${Buffer.from(raw).toString('base64')}` }
}

/**
 * `accessUrl` embeds basic-auth credentials for the owner's full bank history — it is a
 * secret. It must never reach an error message or a log line, which is why the throw below
 * carries the status and nothing else.
 */
export async function fetchAccounts(accessUrl: string, sinceEpochSeconds: number): Promise<unknown> {
  const url = new URL(`${accessUrl}/accounts`)
  url.searchParams.set('start-date', String(sinceEpochSeconds))
  const auth = takeBasicAuth(url)
  const res = await fetch(url, { headers: { Accept: 'application/json', ...auth } })
  if (!res.ok) throw new Error(`SimpleFIN fetch failed: ${res.status}`)
  return res.json()
}
