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

/**
 * The subset of SimpleFIN's `/accounts` payload we read. Asserted, not validated.
 *
 * The three numeric fields are `unknown` rather than `number` / `string | number`, and that is
 * the honest type: this is parsed JSON from someone else's server, so a field a bank omits or
 * blanks arrives as `undefined`, `null` or `""`. Declaring them numbers here would be an
 * assertion that the very thing `numberFromJson` exists to catch cannot happen.
 */
type RawTransaction = {
  id: string
  posted: unknown
  amount: unknown
  description?: string | null
}

type RawAccount = {
  id: string
  name: string
  balance: unknown
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

/**
 * A JSON number that is actually a number.
 *
 * `Number('')`, `Number(null)` and `Number('  ')` are all a finite **0** — only junk *text*
 * yields NaN. That is the defect `src/lib/form.ts` exists to sweep on the form boundary, and
 * this is its twin on the wire boundary: a payload reporting `"balance": null` or
 * `"amount": ""` otherwise arrives as a wholly plausible zero and is stored as one. Every
 * `Number.isFinite` guard below is only a guard because a blank reaches it as NaN.
 */
function numberFromJson(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return NaN
}

export function normalizeAccountsResponse(json: unknown): {
  accounts: NormalizedAccount[]
  transactions: NormalizedTransaction[]
} {
  const raw = json as { accounts?: RawAccount[] }
  const accounts: NormalizedAccount[] = []
  const transactions: NormalizedTransaction[] = []

  for (const a of raw.accounts ?? []) {
    const dollars = numberFromJson(a.balance)
    // Not payload validation — an assertion on a value about to become an account row. It
    // has two failure modes and only one of them looks like a failure.
    //
    // Junk text is NaN, `NaN >= 0` is false, and the account is written as a *liability*
    // with a NaN balance: an inverted `isAsset` that can outlive the snapshot insert that
    // rejects the NaN, since there is no transaction around the two.
    //
    // A blank — `null`, `""`, `"  "` — is the quiet one. Through plain `Number` it is a
    // finite 0, which passes this guard, and `0 >= 0` classifies a credit card as an
    // *asset* worth $0.00: `applySync` updates `accounts.is_asset` on conflict, so the card
    // also leaves /debts with its APR and minimum payment, net worth rises, and that day's
    // snapshot is wrong for good — a one-day dent no later sync repairs. `numberFromJson`
    // is what makes both cases arrive here as NaN.
    //
    // Names the account, not the balance, so the message can be logged.
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
      // Both fields get the balance's treatment, for a sharper reason: neither has a guard
      // anywhere downstream.
      //
      // `posted: null` is a finite 0 through plain `Number`, which dates the transaction
      // 1970-01-01 without a word — a real amount filed against a snapshot fifty years
      // early. An absent `posted` is NaN, and `new Date(NaN).toISOString()` throws a
      // `RangeError` that kills the run *after* this payload's accounts and snapshots are
      // written, with no transaction to undo them.
      //
      // A blank `amount` writes a $0.00 transaction. Junk text is NaN, and drizzle's
      // `PgBigInt53` has no `mapToDriverValue`, so the NaN reaches Postgres verbatim and
      // the insert errors — the same half-applied run by a different route.
      //
      // Both throws name the transaction id and never the value: an amount and a
      // description are the owner's financial data, and this message can be logged.
      const posted = numberFromJson(t.posted)
      if (!Number.isFinite(posted)) {
        throw new Error(`SimpleFIN transaction ${t.id} reported an unusable posted date`)
      }
      const amountDollars = numberFromJson(t.amount)
      if (!Number.isFinite(amountDollars)) {
        throw new Error(`SimpleFIN transaction ${t.id} reported an unusable amount`)
      }

      transactions.push({
        simplefinId: t.id,
        simplefinAccountId: a.id,
        date: isoDate(posted),
        // Unlike a balance, a transaction amount keeps its sign: negative is money leaving.
        amount: dollarsToCents(amountDollars),
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
