import { auth } from '@clerk/nextjs/server'
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { ownerEmail } from '@/lib/auth'
import { centsToDollars, formatCents } from '@/lib/money'
import { addGoal, loadDebtsAndGoals, setDebtTerms } from './actions'

/**
 * The two things the owner tracks alongside net worth: what each debt costs, and what they are
 * saving towards.
 *
 * **Neither feeds the net worth figure.** The balances shown here are already in it, by way of
 * the same snapshots the dashboard reads; an APR, a minimum payment, a payoff target and a
 * goal are context. Entry and display only — no payoff projection, no amortisation, no
 * interest arithmetic, no forecast of when a goal is reached. Those are Phase 2 and they
 * belong in tested pure functions beside `net-worth.ts`, not inside a component.
 *
 * The rule this page exists to keep is that every stored integer is translated on the way out.
 * Money is cents and rates are basis points, so a raw `525` here reads as a 525% loan and a
 * raw `940000` as a nine-hundred-thousand dollar car — and `tsc` accepts both, because a
 * `number` is a valid `ReactNode`.
 */
export default async function DebtsPage() {
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

  const { debts, goals, accountOptions } = await loadDebtsAndGoals(db)

  async function saveTerms(formData: FormData) {
    'use server'
    // Not redundant with the check above. An inline Server Action is a POST endpoint with a
    // stable id: it is invoked directly, without this component body running again, so the
    // gate that guarded the render does not guard the write.
    await requireOwner()
    // An untouched `<input type="date">` submits the empty string, which reaches a `date`
    // column as a driver error rather than as "no target".
    const payoff = String(formData.get('targetPayoff') ?? '')
    await setDebtTerms(db, {
      accountId: String(formData.get('accountId')),
      aprPercent: Number(formData.get('apr')),
      minimumPaymentDollars: Number(formData.get('minimum')),
      targetPayoff: payoff || null,
    })
    revalidatePath('/debts')
  }

  async function createGoal(formData: FormData) {
    'use server'
    await requireOwner()
    const date = String(formData.get('targetDate') ?? '')
    const linked = String(formData.get('linkedAccountId') ?? '')
    await addGoal(db, {
      name: String(formData.get('name')),
      targetAmountDollars: Number(formData.get('target')),
      targetDate: date || null,
      linkedAccountId: linked || null,
    })
    revalidatePath('/debts')
  }

  return (
    <main className="mx-auto max-w-3xl space-y-10 p-8">
      <section>
        <h1 className="mb-4 text-2xl font-semibold">Debts</h1>
        {debts.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No accounts on the liability side yet. Credit cards and loans appear here once the
            bank sync has seen them.
          </p>
        ) : (
          <ul className="divide-y">
            {debts.map((d) => (
              <li key={d.accountId} className="py-3">
                <div className="flex items-baseline justify-between">
                  <span>{d.name}</span>
                  <span className="tabular-nums">
                    {/* Not `formatCents(d.balance ?? 0)`: an account whose first snapshot has
                        never been written would read as a debt paid off in full. */}
                    {d.balance === null ? 'No balance yet' : formatCents(d.balance)}
                  </span>
                </div>
                <div className="text-sm text-neutral-500">
                  {d.terms
                    ? `${(d.terms.aprBps / 100).toFixed(2)}% APR · minimum ` +
                      `${formatCents(d.terms.minimumPayment)}` +
                      `${d.terms.targetPayoff ? ` · pay off by ${d.terms.targetPayoff}` : ''}`
                    : 'No terms set'}
                </div>
                <form action={saveTerms} className="mt-2 grid grid-cols-4 gap-2">
                  <input type="hidden" name="accountId" value={d.accountId} />
                  <input name="apr" type="number" step="0.01" min="0" placeholder="APR %"
                         required defaultValue={d.terms ? d.terms.aprBps / 100 : ''}
                         className="rounded border p-1 text-sm" />
                  <input name="minimum" type="number" step="0.01" min="0" placeholder="Min payment"
                         required
                         defaultValue={d.terms ? centsToDollars(d.terms.minimumPayment) : ''}
                         className="rounded border p-1 text-sm" />
                  <input name="targetPayoff" type="date" defaultValue={d.terms?.targetPayoff ?? ''}
                         className="rounded border p-1 text-sm" />
                  <button className="rounded bg-neutral-900 p-1 text-sm text-white">Save</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-2xl font-semibold">Goals</h2>
        {goals.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No goals yet. Add one below and link it to the account the money is actually in.
          </p>
        ) : (
          <ul className="divide-y">
            {goals.map((g) => (
              <li key={g.id} className="py-3">
                <div className="flex items-baseline justify-between">
                  <span>{g.name}</span>
                  <span className="tabular-nums">
                    {/* Progress is stated only when it is known. `$0.00 / $15,000.00 (0%)` for
                        an unlinked goal claims the owner has saved nothing towards something
                        nothing here is measuring. */}
                    {g.saved === null
                      ? `Target ${formatCents(g.targetAmount)}`
                      : `${formatCents(g.saved)} / ${formatCents(g.targetAmount)}` +
                        `${progress(g.saved, g.targetAmount)}`}
                  </span>
                </div>
                {g.saved === null && (
                  <div className="text-sm text-neutral-500">
                    {g.linkedAccountId
                      ? 'The linked account has no balance yet, so progress is not tracked.'
                      : 'No linked account, so progress is not tracked.'}
                  </div>
                )}
                {/* "By", not "Target": the line above already says "Target $15,000.00" when
                    progress is unknown, and one row cannot use the word for both the amount
                    and the date. */}
                {g.targetDate && (
                  <div className="text-sm text-neutral-500">By {g.targetDate}</div>
                )}
              </li>
            ))}
          </ul>
        )}

        <form action={createGoal} className="mt-4 grid grid-cols-2 gap-3">
          <input name="name" placeholder="Goal name" required className="rounded border p-2" />
          <input name="target" type="number" step="0.01" min="0.01" placeholder="Target in dollars"
                 required className="rounded border p-2" />
          <input name="targetDate" type="date" className="rounded border p-2" />
          <select name="linkedAccountId" className="rounded border p-2">
            <option value="">No linked account</option>
            {/* Every account, not only the liabilities the plan listed. That restriction was
                written before Phase 1 had synced asset accounts, and it left the one thing a
                savings goal is actually saved into — a savings account — unpickable. */}
            {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="col-span-2 rounded bg-neutral-900 p-2 text-white">Add goal</button>
        </form>
        <p className="mt-2 text-sm text-neutral-500">
          Progress is the linked account&rsquo;s latest synced balance. Nothing on this page
          changes net worth.
        </p>
      </section>
    </main>
  )
}

/**
 * ` (40%)`, or the empty string when the target cannot be divided by.
 *
 * `addGoal` refuses a target of zero because it is this denominator, so the guard is for rows
 * that predate it: `Math.round(600000 / 0 * 100)` is `Infinity`, and React renders that
 * literally. Numerator and denominator in this order — inverted, $6,000 of $15,000 reads as
 * 250%, a goal comfortably smashed.
 */
function progress(savedCents: number, targetCents: number): string {
  if (targetCents <= 0) return ''
  return ` (${Math.round((savedCents / targetCents) * 100)}%)`
}

/** Throws unless the caller is the owner. The write path's half of the gate above. */
async function requireOwner() {
  const { sessionClaims } = await auth()
  if (!ownerEmail(sessionClaims)) {
    throw new Error('Not authorised: this account is not the owner of this MoneyWorks install.')
  }
}
