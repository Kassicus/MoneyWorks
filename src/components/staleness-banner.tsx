/**
 * Says how old the numbers are, and nothing else.
 *
 * It is deliberately given only a `Date | null` — never a `sync_runs` row. `sync_runs.error`
 * holds `String(err)`, and drizzle's messages embed the failing SQL statement together with
 * its bound parameters: account names, transaction descriptions. No credential, but not
 * banner copy either.
 */
export function StalenessBanner({ syncedAt }: { syncedAt: Date | null }) {
  // An empty `sync_runs` table does not only mean "new install". If CRON_SECRET is unset in
  // Vercel, the route rejects the nightly cron request at the door — before `runSyncJob`
  // writes even a failure row — so a misconfigured deploy looks exactly like day one and
  // stays that way forever. This banner is the only place that ever surfaces it, so the copy
  // has to name the cause rather than just state the fact.
  if (!syncedAt) {
    return (
      <p role="status" className="rounded bg-amber-100 p-3 text-sm text-amber-900">
        <strong className="font-semibold">No sync has ever completed.</strong> Nothing has been
        fetched, so any figure below is only what is already stored. If this install is more
        than a day old, the nightly job is not running: check that <code>CRON_SECRET</code> is
        set in the Vercel project (an unset secret makes <code>/api/sync</code> reject the cron
        request before it can record the failure) and that the SimpleFIN setup token was
        claimed.
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
