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
    const dollars = Number(a.balance)
    // Not payload validation — an assertion on a value about to become an account row.
    // `Number.isFinite` is false for a missing or non-numeric balance, and `NaN >= 0` is
    // false, so without this the account would be written as a *liability* with a NaN
    // balance: an inverted `isAsset` that can outlive the snapshot insert that rejects the
    // NaN, depending on the caller's transaction boundary. Names the account, not the
    // balance, so the message can be logged.
    if (!Number.isFinite(dollars)) {
      throw new Error(`SimpleFIN account ${a.id} reported an unusable balance`)
    }
    const signed = dollarsToCents(dollars)
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

/**
 * One-time exchange of a setup token for a permanent access URL. This POST is the only
 * write this app ever issues to SimpleFIN.
 */
export async function claimAccessUrl(setupToken: string): Promise<string> {
  // Base64 decoding is lenient, so a corrupt token yields a garbage string rather than an
  // error, and `fetch` would then throw `Failed to parse URL from <that string>` — putting
  // the decoded token into the message. Parse it here so the throw is ours and says nothing.
  const url = parseUrl(Buffer.from(setupToken, 'base64').toString('utf8'), 'setup token')
  const auth = takeBasicAuth(url)
  const res = await fetch(url, { method: 'POST', headers: { ...auth } })
  if (!res.ok) throw new Error(`SimpleFIN claim failed: ${res.status}`)
  return (await res.text()).trim()
}

/**
 * `new URL()` throws a `TypeError` whose message is clean but which keeps the entire input
 * in `err.input` — so `console.error(err)` or `JSON.stringify(err)` prints the credential
 * even though `err.message` looks safe. Re-throw a plain `Error` that carries none of it.
 */
function parseUrl(candidate: string, describedAs: string): URL {
  try {
    return new URL(candidate)
  } catch {
    throw new Error(`SimpleFIN ${describedAs} is malformed`)
  }
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
  const url = parseUrl(`${accessUrl}/accounts`, 'access URL')
  url.searchParams.set('start-date', String(sinceEpochSeconds))
  const auth = takeBasicAuth(url)
  const res = await fetch(url, { headers: { Accept: 'application/json', ...auth } })
  if (!res.ok) throw new Error(`SimpleFIN fetch failed: ${res.status}`)
  return res.json()
}
