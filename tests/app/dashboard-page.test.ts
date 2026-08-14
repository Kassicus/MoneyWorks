import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AccountBalance, ManualAssetValue } from '@/lib/net-worth'
import { textOf } from '../helpers/element-tree'

/**
 * Two things, and the first is a negative: a caller who is not the owner must not cause the
 * dashboard to *read* their finances, not merely to render them. `ownerEmail` has its own
 * exhaustive suite and the queries have theirs; this file exists only because neither of
 * those notices if the page stops calling the gate, or calls it after loading the data.
 *
 * That is why those tests take the same shape as `tests/app/sync-route.test.ts`: mock the
 * boundary, then assert the work did *not* happen.
 *
 * The second is the headline figure itself, which is the whole product on one line — see
 * the last describe. `tsc` accepts a `number` as a `ReactNode`, so nothing but an assertion
 * on the rendered text stops `$400,000.00` becoming `40000000`.
 *
 * `@/db/client` must be mocked because it calls `neon(process.env.DATABASE_URL!)` at import
 * time and there is no database in this suite; the handle is only passed through.
 */

const auth = vi.fn<() => Promise<{ sessionClaims: unknown }>>()
// Annotated rather than inferred from the empty arrays below, so a test can hand it real
// rows: `netWorthOn` is not mocked, and the number it computes is what the page renders.
const loadNetWorthInputs = vi.fn(async (): Promise<{
  snapshots: AccountBalance[]
  manual: ManualAssetValue[]
}> => ({ snapshots: [], manual: [] }))
const lastSuccessfulSync = vi.fn(async (): Promise<Date | null> => null)
const hasAnySyncRun = vi.fn(async () => false)

vi.mock('@clerk/nextjs/server', () => ({ auth }))
vi.mock('@/db/client', () => ({ db: { marker: 'test-db-handle' } }))
vi.mock('@/lib/queries', () => ({ loadNetWorthInputs, lastSuccessfulSync, hasAnySyncRun }))
// recharts is a browser component tree; the page only needs to be able to name it.
vi.mock('@/components/net-worth-chart', () => ({ NetWorthChart: () => null }))

const { default: DashboardPage } = await import('@/app/(app)/page')

beforeEach(() => {
  process.env.ALLOWED_EMAIL = 'owner@example.com'
  vi.clearAllMocks()
})

describe('the dashboard page checks the caller itself', () => {
  // The middleware checks this too. It is not redundant: middleware auth is path matching,
  // which can diverge from how Next actually routes a request — that is how `/dashboard.rsc`
  // came to be reachable under the plan's original matcher, and it is why Clerk deprecated
  // `createRouteMatcher`. The two layers fail in different ways, so both must hold.
  it('reads nothing at all for a signed-in identity that is not the owner', async () => {
    auth.mockResolvedValue({ sessionClaims: { email: 'someone@else.com' } })

    await DashboardPage()

    expect(loadNetWorthInputs).not.toHaveBeenCalled()
    expect(lastSuccessfulSync).not.toHaveBeenCalled()
    expect(hasAnySyncRun).not.toHaveBeenCalled()
  })

  it('reads nothing when the session carries no email claim', async () => {
    // The default Clerk session token has no `email` claim until it is added in the
    // dashboard, so this is the state a fresh deploy is in.
    auth.mockResolvedValue({ sessionClaims: { sub: 'user_123' } })

    await DashboardPage()

    expect(loadNetWorthInputs).not.toHaveBeenCalled()
  })

  it('reads nothing when ALLOWED_EMAIL is unset, even for a well-formed claim', async () => {
    delete process.env.ALLOWED_EMAIL
    auth.mockResolvedValue({ sessionClaims: { email: 'owner@example.com' } })

    await DashboardPage()

    expect(loadNetWorthInputs).not.toHaveBeenCalled()
  })

  it('loads the dashboard data for the owner', async () => {
    auth.mockResolvedValue({ sessionClaims: { email: 'owner@example.com' } })

    await DashboardPage()

    expect(loadNetWorthInputs).toHaveBeenCalledTimes(1)
    expect(lastSuccessfulSync).toHaveBeenCalledTimes(1)
  })
})

describe('the dashboard renders what it read', () => {
  /**
   * The product's headline number, and the last unpinned money boundary in the app: money is
   * integer cents everywhere and becomes dollars only here, at the render. `tsc` cannot
   * defend that, because a `number` is a perfectly good `ReactNode` — dropping `formatCents`
   * prints `40000000` in 5xl type where `$400,000.00` belongs, and every other test in the
   * project still passes. The same assertion guards the assets and debts pages.
   */
  it('formats net worth as dollars, never as raw cents', async () => {
    auth.mockResolvedValue({ sessionClaims: { email: 'owner@example.com' } })
    // One snapshot, dated in the past, so `netWorthOn(today, …)` carries it forward to
    // whatever day the suite runs on.
    loadNetWorthInputs.mockResolvedValueOnce({
      snapshots: [
        { accountId: 'acct-1', isAsset: true, date: '2026-01-01', balance: 400_000_00 },
      ],
      manual: [],
    })
    // A fresh sync, so the staleness banner renders nothing and the only text in the tree
    // is the figure under test.
    lastSuccessfulSync.mockResolvedValueOnce(new Date())

    const text = textOf(await DashboardPage())

    expect(text).toContain('$400,000.00')
    expect(text).not.toContain('40000000')
  })
})
