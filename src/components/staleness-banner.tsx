/**
 * Says how old the numbers are, and nothing else.
 *
 * It is deliberately given a `Date | null` and a boolean — never a `sync_runs` row.
 * `sync_runs.error` holds `String(err)`, and drizzle's error messages embed the failing SQL
 * statement together with its bound parameters: account names, transaction descriptions. No
 * credential, but not banner copy either, and `lastSuccessfulSync` never even selects it.
 * Pointing at where to look is enough.
 */
export function StalenessBanner({
  syncedAt,
  hasRun,
}: {
  syncedAt: Date | null
  hasRun: boolean
}) {
  // "No successful sync" is two different faults with opposite remedies, and the owner sees
  // only this banner, so guessing between them would send them to debug whichever part is
  // working. `hasRun` separates them.
  if (!syncedAt) {
    return hasRun ? (
      <p role="status" className="rounded bg-amber-100 p-3 text-sm text-amber-900">
        <strong className="font-semibold">The nightly sync is running but never succeeding.</strong>{' '}
        Figures below are only what is already stored. The job itself is reaching the server, so
        the failure is downstream of the cron — check the newest row in <code>sync_runs</code>,
        or the function logs for <code>/api/sync</code> in Vercel. An expired or unclaimed
        SimpleFIN token is the usual cause.
      </p>
    ) : (
      <p role="status" className="rounded bg-amber-100 p-3 text-sm text-amber-900">
        <strong className="font-semibold">The nightly sync has never run.</strong> Nothing has
        been fetched, so any figure below is only what is already stored. No attempt has been
        recorded at all, which means no request ever reached the job: if this install is more
        than a day old, check that <code>CRON_SECRET</code> is set in the Vercel project.
        Without it <code>/api/sync</code> rejects the cron before it can record the failure,
        so a misconfigured deploy looks exactly like a new one.
      </p>
    )
  }

  // Sync runs nightly, so one missed night is not yet news; two is.
  const days = Math.floor((Date.now() - syncedAt.getTime()) / 86_400_000)
  if (days < 2) return null

  return (
    <p role="status" className="rounded bg-amber-100 p-3 text-sm text-amber-900">
      Last synced {days} days ago — balances may be out of date.
    </p>
  )
}
