import { eq } from 'drizzle-orm'
import { syncRuns } from '@/db/schema'
import type { Db } from '@/db/types'
import { getSecret, putSecret } from '@/lib/secrets'
import { claimAccessUrl, fetchAccounts } from '@/sync/simplefin'
import { applySync } from '@/sync/run'

/**
 * One nightly sync: decrypt the stored SimpleFIN access URL, fetch, apply, and record what
 * happened in `sync_runs`. The HTTP route around it does nothing but authenticate the cron
 * request and turn this result into a response — the work lives here so it can be tested
 * against a real database with only `fetch` stubbed, instead of behind a wall of mocks.
 *
 * ## Not atomic, on purpose
 *
 * `applySync` is not transactional and must not be described as if it were: Neon's HTTP
 * driver has no interactive transactions at runtime (see the header of `sync/run.ts`).
 * A run that dies partway leaves some writes applied. Nothing here rolls anything back, and
 * the `error` row it writes claims only that the run failed, never that it was undone.
 * Recovery is idempotency: every write is an upsert keyed on a stable external id, so the
 * next night repairs whatever a failed night left half-written. That is also why there is no
 * retry and no alerting here — a failed run is recorded, surfaced by the dashboard's
 * staleness banner, and repaired by the next one.
 *
 * ## Nothing that touches a credential may reach an error string
 *
 * `sync_runs.error` and the returned `error` are read by a human and rendered by the
 * dashboard. The access URL and the setup token are credentials for the owner's entire
 * financial history. `String(err)` reads only `name` and `message`, both of which the
 * SimpleFIN client keeps scrubbed; logging or storing the error *object* would print
 * `err.input` — the full credentialed URL — which is exactly the leak the client was
 * rewritten to close. Store the string. Never the object.
 */

const OVERLAP_SECONDS = 7 * 24 * 60 * 60

export type SyncJobResult =
  // `accountsSeen` / `transactionsSeen`, not `written`: `applySync` returns the number of
  // items in the payload, so a re-run reports the same counts having written nothing new.
  | { ok: true; accountsSeen: number; transactionsSeen: number }
  | { ok: false; error: string }

export async function runSyncJob(db: Db, now: Date = new Date()): Promise<SyncJobResult> {
  const [run] = await db.insert(syncRuns).values({ status: 'running' }).returning()

  try {
    let accessUrl = await getSecret(db, 'simplefin_access_url')
    // Guarded, not unconditional: the setup token is single-use and the access URL it buys
    // is permanent, so claiming on every run would fail every run after the first.
    if (!accessUrl) {
      const token = process.env.SIMPLEFIN_SETUP_TOKEN
      if (!token) throw new Error('No access URL stored and SIMPLEFIN_SETUP_TOKEN is unset')
      accessUrl = await claimAccessUrl(token)
      await putSecret(db, 'simplefin_access_url', accessUrl)
    }

    // A 7-day overlap, deliberately, rather than an incremental cursor: institutions revise
    // recently posted transactions, and re-fetching them is free because every write upserts.
    const since = Math.floor(now.getTime() / 1000) - OVERLAP_SECONDS
    const payload = await fetchAccounts(accessUrl, since)
    const seen = await applySync(db, payload, now.toISOString().slice(0, 10))

    await db.update(syncRuns)
      .set({ status: 'ok', finishedAt: new Date() })
      .where(eq(syncRuns.id, run.id))

    return { ok: true, accountsSeen: seen.accounts, transactionsSeen: seen.transactions }
  } catch (err) {
    const error = String(err)
    await db.update(syncRuns)
      .set({ status: 'error', error, finishedAt: new Date() })
      .where(eq(syncRuns.id, run.id))
    return { ok: false, error }
  }
}
