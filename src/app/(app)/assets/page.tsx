import { auth } from '@clerk/nextjs/server'
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { ownerEmail } from '@/lib/auth'
import { formatCents } from '@/lib/money'
import { addManualAsset, latestManualAssets, revalueManualAsset } from './actions'

/**
 * Everything SimpleFIN cannot reach: a house, a car, a 401k at a provider that will not
 * connect, a private loan. Without these the headline figure is understated by the largest
 * number most people own.
 *
 * Two forms, and no third. There is no delete and no editing of a past valuation, because a
 * valuation is a historical fact: the way to say a house is worth less now is to revalue it
 * now, which appends a row and leaves January's net worth alone.
 */
export default async function AssetsPage() {
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
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-lg font-semibold">Not authorised</h1>
        <p className="mt-2 text-sm text-neutral-600">
          This account is not the owner of this MoneyWorks install.
        </p>
      </main>
    )
  }

  const assets = await latestManualAssets(db)

  async function create(formData: FormData) {
    'use server'
    // Not redundant with the check above. An inline Server Action is a POST endpoint with a
    // stable id: it is invoked directly, without this component body running again, so the
    // gate that guarded the render does not guard the write.
    await requireOwner()
    await addManualAsset(db, {
      name: String(formData.get('name')),
      kind: String(formData.get('kind')),
      // An unticked checkbox is absent from the payload entirely, not present-and-false.
      isAsset: formData.get('isAsset') === 'on',
      valueDollars: Number(formData.get('value')),
      asOf: String(formData.get('asOf')),
    })
    revalidatePath('/assets')
  }

  async function revalue(formData: FormData) {
    'use server'
    await requireOwner()
    // Three fields, and deliberately not `kind` or `isAsset`: the action copies those forward
    // from the prior row, so a revaluation cannot turn an asset into a liability and move net
    // worth by twice its value.
    await revalueManualAsset(db, {
      name: String(formData.get('name')),
      valueDollars: Number(formData.get('value')),
      asOf: String(formData.get('asOf')),
    })
    revalidatePath('/assets')
  }

  return (
    <main className="mx-auto max-w-3xl space-y-10 p-8">
      <section>
        <h1 className="mb-4 text-2xl font-semibold">Manual assets</h1>
        {assets.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nothing here yet. Add the things the bank sync cannot see — a house, a car, a
            retirement account that will not connect, a private loan.
          </p>
        ) : (
          <ul className="divide-y">
            {assets.map((a) => (
              <li key={a.name} className="flex items-baseline justify-between py-3">
                <span>
                  {a.name}
                  <span className="ml-2 text-sm text-neutral-500">
                    {a.isAsset ? 'asset' : 'liability'} · as of {a.asOf}
                  </span>
                </span>
                <span className="tabular-nums">{formatCents(a.value)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-medium">Add</h2>
        <form action={create} className="grid grid-cols-2 gap-3">
          <input name="name" placeholder="Name" required className="rounded border p-2" />
          <select name="kind" className="rounded border p-2">
            <option value="property">Property</option>
            <option value="vehicle">Vehicle</option>
            <option value="retirement">Retirement</option>
            <option value="other">Other</option>
          </select>
          <input name="value" type="number" step="0.01" min="0" placeholder="Value in dollars"
                 required className="rounded border p-2" />
          <input name="asOf" type="date" required className="rounded border p-2" />
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input name="isAsset" type="checkbox" defaultChecked /> This is an asset (uncheck for a liability)
          </label>
          <button className="col-span-2 rounded bg-neutral-900 p-2 text-white">Add</button>
        </form>
        <p className="mt-2 text-sm text-neutral-500">
          Enter a liability as a positive amount and untick the box. Each name is used once —
          to update a value, revalue it below.
        </p>
      </section>

      {assets.length > 0 && (
        <section>
          <h2 className="mb-3 font-medium">Revalue</h2>
          <p className="mb-2 text-sm text-neutral-500">
            Adds a new valuation dated as-of. Past net worth is not rewritten.
          </p>
          <form action={revalue} className="grid grid-cols-3 gap-3">
            <select name="name" className="rounded border p-2">
              {assets.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
            <input name="value" type="number" step="0.01" min="0" placeholder="New value"
                   required className="rounded border p-2" />
            <input name="asOf" type="date" required className="rounded border p-2" />
            <button className="col-span-3 rounded bg-neutral-900 p-2 text-white">Revalue</button>
          </form>
        </section>
      )}
    </main>
  )
}

/** Throws unless the caller is the owner. The write path's half of the gate above. */
async function requireOwner() {
  const { sessionClaims } = await auth()
  if (!ownerEmail(sessionClaims)) {
    throw new Error('Not authorised: this account is not the owner of this MoneyWorks install.')
  }
}
