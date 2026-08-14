import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * One assertion, and it is a negative one: a caller who is not the owner must not cause the
 * dashboard to *read* their finances, not merely to render them. `ownerEmail` has its own
 * exhaustive suite and the queries have theirs; this file exists only because neither of
 * those notices if the page stops calling the gate, or calls it after loading the data.
 *
 * That is also why it takes the same shape as `tests/app/sync-route.test.ts`: mock the
 * boundary, then assert the work did *not* happen. Nothing here checks markup.
 *
 * `@/db/client` must be mocked because it calls `neon(process.env.DATABASE_URL!)` at import
 * time and there is no database in this suite; the handle is only passed through.
 */

const auth = vi.fn<() => Promise<{ sessionClaims: unknown }>>()
const loadNetWorthInputs = vi.fn(async () => ({ snapshots: [], manual: [] }))
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
