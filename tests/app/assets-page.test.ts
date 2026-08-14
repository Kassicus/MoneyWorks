import { describe, it, expect, beforeEach, vi } from 'vitest'
import { findAll, textOf, textByKey } from '../helpers/element-tree'

/**
 * The same shape, and the same one idea, as `tests/app/dashboard-page.test.ts`: mock the
 * boundary, then assert the work did *not* happen. Nothing here checks markup.
 *
 * Two things are pinned. The page must not *read* the owner's assets for a caller who is not
 * the owner — not merely not render them — which is why the assertions are `not.toHaveBeenCalled`
 * and why moving the gate below the read would fail them. And the page's two Server Actions
 * must check the caller themselves: an inline `'use server'` function is a POST endpoint with
 * a stable id, invocable without the page body ever running again, so a gate that only guards
 * the render leaves the *writes* open. The middleware covers both, and the middleware is path
 * matching that can diverge from how Next routes a request — the `/dashboard.rsc` class of
 * hole, and Clerk's own reason for deprecating `createRouteMatcher`.
 *
 * `@/db/client` must be mocked because it calls `neon(process.env.DATABASE_URL!)` at import
 * time and there is no database in this suite; the handle is only passed through.
 */

const auth = vi.fn<() => Promise<{ sessionClaims: unknown }>>()
// One asset, so the revalue form — which has nothing to offer on an empty install — renders.
const latestManualAssets = vi.fn(async () => [
  { name: 'House', kind: 'property', isAsset: true, value: 400_000_00, asOf: '2026-01-01' },
])
const addManualAsset = vi.fn(async () => {})
const revalueManualAsset = vi.fn(async () => {})
const revalidatePath = vi.fn()

vi.mock('@clerk/nextjs/server', () => ({ auth }))
vi.mock('@/db/client', () => ({ db: { marker: 'test-db-handle' } }))
vi.mock('next/cache', () => ({ revalidatePath }))
vi.mock('@/app/(app)/assets/actions', () => ({
  latestManualAssets, addManualAsset, revalueManualAsset,
}))

const { default: AssetsPage } = await import('@/app/(app)/assets/page')

type Action = (formData: FormData) => Promise<void>

/**
 * Every `action` prop in the rendered tree, in document order.
 *
 * The Server Actions are closures inside the component, so there is no export to import and
 * no other way to reach them. Walking the returned element tree is the price of testing the
 * thing that actually receives the POST.
 */
function formActions(node: unknown): Action[] {
  return findAll(node, 'form')
    .map((el) => el.props?.action)
    .filter((a): a is Action => typeof a === 'function')
}

const asOwner = () => auth.mockResolvedValue({ sessionClaims: { email: 'owner@example.com' } })

const mortgage = {
  name: 'Mortgage', kind: 'loan', isAsset: false, value: 250_000_00, asOf: '2026-02-01',
}

const form = (entries: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(entries)) fd.set(k, v)
  return fd
}

beforeEach(() => {
  process.env.ALLOWED_EMAIL = 'owner@example.com'
  vi.clearAllMocks()
})

describe('the manual assets page checks the caller itself', () => {
  it('reads nothing at all for a signed-in identity that is not the owner', async () => {
    auth.mockResolvedValue({ sessionClaims: { email: 'someone@else.com' } })

    await AssetsPage()

    expect(latestManualAssets).not.toHaveBeenCalled()
  })

  it('reads nothing when the session carries no email claim', async () => {
    // The default Clerk session token has no `email` claim until it is added in the
    // dashboard, so this is the state a fresh deploy is in.
    auth.mockResolvedValue({ sessionClaims: { sub: 'user_123' } })

    await AssetsPage()

    expect(latestManualAssets).not.toHaveBeenCalled()
  })

  it('reads nothing when ALLOWED_EMAIL is unset, even for a well-formed claim', async () => {
    delete process.env.ALLOWED_EMAIL
    auth.mockResolvedValue({ sessionClaims: { email: 'owner@example.com' } })

    await AssetsPage()

    expect(latestManualAssets).not.toHaveBeenCalled()
  })

  it('lists the owner’s assets for the owner', async () => {
    asOwner()

    await AssetsPage()

    expect(latestManualAssets).toHaveBeenCalledTimes(1)
  })
})

describe('the manual assets page renders what it read', () => {
  /**
   * The one place in this task where the global "money is integer cents, dollars only at the
   * render boundary" constraint actually lives — and `tsc` cannot defend it, because a
   * `number` is a perfectly valid `ReactNode`. Dropping `formatCents` renders `40000000`
   * where `$400,000.00` belongs and every other test in the project still passes.
   */
  it('formats each valuation as dollars, never as raw cents', async () => {
    asOwner()
    latestManualAssets.mockResolvedValueOnce([
      { name: 'House', kind: 'property', isAsset: true, value: 400_000_00, asOf: '2026-01-01' },
      mortgage,
    ])

    const byName = textByKey(await AssetsPage(), 'li')

    expect(byName.House).toContain('$400,000.00')
    expect(byName.House).not.toContain('40000000')
    expect(byName.Mortgage).toContain('$250,000.00')
    expect(byName.Mortgage).not.toContain('25000000')
  })

  /**
   * Liabilities are stored as a positive magnitude, so the only thing separating a $250,000
   * debt from a $250,000 asset on this page is this label. Inverting it leaves net worth
   * correct and the page a lie, which no other assertion notices.
   */
  it('says which side of the ledger each asset is on', async () => {
    asOwner()
    latestManualAssets.mockResolvedValueOnce([
      { name: 'House', kind: 'property', isAsset: true, value: 400_000_00, asOf: '2026-01-01' },
      mortgage,
    ])

    const byName = textByKey(await AssetsPage(), 'li')

    expect(byName.House).toContain('asset')
    expect(byName.House).not.toContain('liability')
    expect(byName.Mortgage).toContain('liability')
    // Both rows also carry the date the figure is as of, which is the only cue that a number
    // is stale.
    expect(byName.Mortgage).toContain('2026-02-01')
  })
})

describe('the manual assets page on an empty install', () => {
  /**
   * The justification for deviating from the brief here: its version always renders the
   * revalue form, and on a fresh install that is a `<select>` with no `<option>`s, which
   * submits `name: "null"` and throws. Nothing but this test stops that being reintroduced —
   * every other test in this file mocks the loader with an asset in it.
   */
  it('offers the add form only — no revalue form with an empty dropdown', async () => {
    asOwner()
    latestManualAssets.mockResolvedValueOnce([])

    const tree = await AssetsPage()
    const actions = formActions(tree)

    expect(actions).toHaveLength(1)
    // And the one that survived is Add, not Revalue.
    await actions[0](form({
      name: 'House', kind: 'property', value: '400000', asOf: '2026-01-01', isAsset: 'on',
    }))
    expect(addManualAsset).toHaveBeenCalledTimes(1)
    expect(revalueManualAsset).not.toHaveBeenCalled()
  })

  it('says what the page is for instead of showing an empty list', async () => {
    asOwner()
    latestManualAssets.mockResolvedValueOnce([])

    expect(textOf(await AssetsPage())).toContain('Nothing here yet')
  })
})

describe('the manual assets page’s Server Actions check the caller too', () => {
  it('writes nothing when an action is invoked by someone who is not the owner', async () => {
    asOwner()
    const actions = formActions(await AssetsPage())
    expect(actions).toHaveLength(2)

    // The page rendered for the owner; the POST arrives from someone else. Nothing about the
    // earlier render may carry over into the write.
    auth.mockResolvedValue({ sessionClaims: { email: 'someone@else.com' } })

    for (const action of actions) {
      await expect(action(form({
        name: 'House', kind: 'property', value: '400000', asOf: '2026-01-01', isAsset: 'on',
      }))).rejects.toThrow(/owner/i)
    }

    expect(addManualAsset).not.toHaveBeenCalled()
    expect(revalueManualAsset).not.toHaveBeenCalled()
  })

  it('adds an asset from the form, in dollars, leaving cents to the action module', async () => {
    asOwner()
    const [create] = formActions(await AssetsPage())

    await create(form({
      name: 'House', kind: 'property', value: '420000.50', asOf: '2026-01-01', isAsset: 'on',
    }))

    expect(addManualAsset).toHaveBeenCalledWith({ marker: 'test-db-handle' }, {
      name: 'House', kind: 'property', isAsset: true, valueDollars: 420000.5, asOf: '2026-01-01',
    })
    expect(revalidatePath).toHaveBeenCalledWith('/assets')
  })

  it('adds a liability when the asset box is unticked', async () => {
    asOwner()
    const [create] = formActions(await AssetsPage())

    // An unticked checkbox is absent from the FormData entirely, not present-and-false.
    await create(form({
      name: 'Mortgage', kind: 'loan', value: '250000', asOf: '2026-01-01',
    }))

    expect(addManualAsset).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ name: 'Mortgage', isAsset: false }))
  })

  it('revalues without offering kind or the asset flag', async () => {
    asOwner()
    const [, revalue] = formActions(await AssetsPage())

    await revalue(form({ name: 'House', value: '430000', asOf: '2026-07-01' }))

    // Exactly three fields: a revaluation that could re-sign an asset would move net worth by
    // twice its value.
    expect(revalueManualAsset).toHaveBeenCalledWith({ marker: 'test-db-handle' }, {
      name: 'House', valueDollars: 430000, asOf: '2026-07-01',
    })
    expect(revalidatePath).toHaveBeenCalledWith('/assets')
  })
})
