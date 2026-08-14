import { auth } from '@clerk/nextjs/server'
import { db } from '@/db/client'
import { ownerEmail } from '@/lib/auth'
import { formatCents } from '@/lib/money'
import { chartDates, netWorthOn, netWorthSeries } from '@/lib/net-worth'
import { loadNetWorthInputs, lastSuccessfulSync, hasAnySyncRun } from '@/lib/queries'
import { NetWorthChart } from '@/components/net-worth-chart'
import { StalenessBanner } from '@/components/staleness-banner'

/**
 * The dashboard. One number, one chart, one banner.
 *
 * Net worth is derived here, at read time, from the whole snapshot history — never stored.
 * Correcting a wrong balance therefore corrects the entire chart, not just today.
 */
export default async function DashboardPage() {
  // Checked here as well as in the middleware, and the two fail differently on purpose.
  // Middleware auth is path matching, which can diverge from how Next actually routes a
  // request — the reason Clerk deprecated `createRouteMatcher`, and the reason `/dashboard.rsc`
  // was reachable under the plan's original matcher. A page that reads the owner's finances
  // verifies the caller itself. If `clerkMiddleware` did not run at all, `auth()` throws
  // rather than returning an anonymous session, so that path fails closed too.
  const { sessionClaims } = await auth()
  if (!ownerEmail(sessionClaims)) {
    // Return before touching the database: nothing financial is read, let alone rendered.
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-lg font-semibold">Not authorised</h1>
        <p className="mt-2 text-sm text-neutral-600">
          This account is not the owner of this MoneyWorks install.
        </p>
      </main>
    )
  }

  const { snapshots, manual } = await loadNetWorthInputs(db)
  const syncedAt = await lastSuccessfulSync(db)
  // Only asked when there is no successful sync to report, which is the only case whose copy
  // depends on it. On a healthy install this is never queried.
  const hasRun = syncedAt ? true : await hasAnySyncRun(db)

  // UTC, matching the date `applySync` stamps its snapshots with. A local-time "today" would
  // ask for a date the sync has not written yet in the evening west of UTC, and `netWorthOn`
  // would carry yesterday forward — right answer, but by luck rather than by construction.
  const today = new Date().toISOString().slice(0, 10)

  const current = netWorthOn(today, snapshots, manual)
  const series = netWorthSeries(chartDates(snapshots, manual, today), snapshots, manual)

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-8">
      <StalenessBanner syncedAt={syncedAt} hasRun={hasRun} />
      <section>
        <h1 className="text-sm uppercase tracking-wide text-neutral-500">Net worth</h1>
        <p className="text-5xl font-semibold tabular-nums">{formatCents(current)}</p>
      </section>
      <NetWorthChart data={series} />
    </main>
  )
}
