import { describe, it, expect, beforeEach, vi } from 'vitest'
import { findAll, textOf, textByKey } from '../helpers/element-tree'

/**
 * The same shape, and the same one idea, as `tests/app/assets-page.test.ts`: mock the boundary,
 * then assert the work did *not* happen. Nothing here checks markup.
 *
 * Three things are pinned. The page must not *read* the owner's debts for a caller who is not
 * the owner — not merely not render them — which is why the assertion is `not.toHaveBeenCalled`
 * and why moving the gate below the read would fail it. The page's Server Actions must check
 * the caller themselves, because an inline `'use server'` function is a POST endpoint with a
 * stable id, invocable without the page body ever running again. And every figure must reach
 * the page as a rendered *string* — dollars for money, a percentage for a rate — because `tsc`
 * is happy to render a raw `number` and no other test in the project would notice.
 *
 * `@/db/client` must be mocked because it calls `neon(process.env.DATABASE_URL!)` at import
 * time and there is no database in this suite; the handle is only passed through.
 */

const auth = vi.fn<() => Promise<{ sessionClaims: unknown }>>()
const setDebtTerms = vi.fn(async () => {})
const addGoal = vi.fn(async () => {})
const revalidatePath = vi.fn()

type Terms = { aprBps: number; minimumPayment: number; targetPayoff: string | null }
type Debt = { accountId: string; name: string; balance: number | null; terms: Terms | null }
type Goal = {
  id: string; name: string; targetAmount: number; targetDate: string | null
  linkedAccountId: string | null; saved: number | null
}
type Loaded = { debts: Debt[]; goals: Goal[]; accountOptions: { id: string; name: string }[] }

const carLoan: Debt = {
  accountId: 'acct-car',
  name: 'Car Loan',
  balance: 9_400_00,
  terms: { aprBps: 525, minimumPayment: 412_50, targetPayoff: '2029-06-01' },
}

const emergencyFund: Goal = {
  id: 'goal-ef',
  name: 'Emergency fund',
  targetAmount: 15_000_00,
  targetDate: '2027-01-01',
  linkedAccountId: 'acct-savings',
  saved: 6_000_00,
}

const loaded = (over: Partial<Loaded> = {}): Loaded => ({
  debts: [carLoan],
  goals: [emergencyFund],
  accountOptions: [{ id: 'acct-car', name: 'Car Loan' }, { id: 'acct-savings', name: 'Savings' }],
  ...over,
})

const loadDebtsAndGoals = vi.fn(async (): Promise<Loaded> => loaded())

vi.mock('@clerk/nextjs/server', () => ({ auth }))
vi.mock('@/db/client', () => ({ db: { marker: 'test-db-handle' } }))
vi.mock('next/cache', () => ({ revalidatePath }))
vi.mock('@/app/(app)/debts/actions', () => ({ loadDebtsAndGoals, setDebtTerms, addGoal }))

const { default: DebtsPage } = await import('@/app/(app)/debts/page')

type Action = (formData: FormData) => Promise<void>

/**
 * Every `action` prop in the rendered tree, in document order.
 *
 * The Server Actions are closures inside the component, so there is no export to import and no
 * other way to reach them. Walking the returned element tree is the price of testing the thing
 * that actually receives the POST.
 */
function formActions(node: unknown): Action[] {
  return findAll(node, 'form')
    .map((el) => el.props?.action)
    .filter((a): a is Action => typeof a === 'function')
}

/**
 * Every `<input>` in the tree, keyed by its `name`.
 *
 * `textOf` and `textByKey` walk `props.children`, so neither of them can see a `defaultValue` —
 * which makes the prefilled form the one boundary on this page that renders storage integers
 * with nothing watching. It is also the more dangerous of the two boundaries, because a form
 * value is not merely displayed: the owner edits one field, presses Save, and every other
 * prefilled box is written straight back into the database.
 */
function inputsByName(node: unknown): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    findAll(node, 'input').map((el) => [String(el.props?.name), el.props ?? {}]),
  )
}

const asOwner = () => auth.mockResolvedValue({ sessionClaims: { email: 'owner@example.com' } })

const form = (entries: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(entries)) fd.set(k, v)
  return fd
}

beforeEach(() => {
  process.env.ALLOWED_EMAIL = 'owner@example.com'
  vi.clearAllMocks()
  loadDebtsAndGoals.mockResolvedValue(loaded())
})

describe('the debts page checks the caller itself', () => {
  it('reads nothing at all for a signed-in identity that is not the owner', async () => {
    auth.mockResolvedValue({ sessionClaims: { email: 'someone@else.com' } })

    await DebtsPage()

    expect(loadDebtsAndGoals).not.toHaveBeenCalled()
  })

  it('reads nothing when the session carries no email claim', async () => {
    // The default Clerk session token has no `email` claim until it is added in the dashboard,
    // so this is the state a fresh deploy is in.
    auth.mockResolvedValue({ sessionClaims: { sub: 'user_123' } })

    await DebtsPage()

    expect(loadDebtsAndGoals).not.toHaveBeenCalled()
  })

  it('reads nothing when ALLOWED_EMAIL is unset, even for a well-formed claim', async () => {
    delete process.env.ALLOWED_EMAIL
    auth.mockResolvedValue({ sessionClaims: { email: 'owner@example.com' } })

    await DebtsPage()

    expect(loadDebtsAndGoals).not.toHaveBeenCalled()
  })

  it('reads the owner’s debts and goals for the owner', async () => {
    asOwner()

    await DebtsPage()

    expect(loadDebtsAndGoals).toHaveBeenCalledTimes(1)
  })
})

describe('the debts page renders money as dollars and rates as percentages', () => {
  /**
   * The one place the global "money is integer cents, dollars only at the render boundary"
   * constraint actually lives — and `tsc` cannot defend it, because a `number` is a perfectly
   * valid `ReactNode`. Dropping `formatCents` renders `940000` where `$9,400.00` belongs and
   * every other test in the project still passes.
   */
  it('renders a debt’s balance and minimum payment as dollars, never as raw cents', async () => {
    asOwner()

    const byId = textByKey(await DebtsPage(), 'li')

    expect(byId['acct-car']).toContain('$9,400.00')
    expect(byId['acct-car']).not.toContain('940000')
    expect(byId['acct-car']).toContain('$412.50')
    expect(byId['acct-car']).not.toContain('41250')
  })

  /**
   * The rate's own render boundary, and the same failure mode one column over: rates are
   * integer basis points, so the stored 525 must reach the page as 5.25%. Printed raw it reads
   * as a 525% loan; divided by 10 or by 1000 it reads as 52.5% or 0.525%.
   */
  it('renders an APR as a percentage, never as raw basis points', async () => {
    asOwner()

    const byId = textByKey(await DebtsPage(), 'li')

    expect(byId['acct-car']).toContain('5.25%')
    expect(byId['acct-car']).not.toContain('525%')
    expect(byId['acct-car']).not.toContain('52.5%')
  })

  it('shows the payoff target a debt is aiming at', async () => {
    asOwner()

    expect(textByKey(await DebtsPage(), 'li')['acct-car']).toContain('2029-06-01')
  })

  /**
   * An account row is written before its first snapshot and `applySync` is not transactional,
   * so a liability with no balance is reachable. `$0.00` would say the loan is paid off.
   */
  it('says a balance is unknown rather than showing it as zero', async () => {
    asOwner()
    loadDebtsAndGoals.mockResolvedValue(loaded({
      debts: [{ ...carLoan, balance: null }],
    }))

    const text = textByKey(await DebtsPage(), 'li')['acct-car']

    expect(text).not.toContain('$0.00')
    expect(text).toMatch(/no balance/i)
  })

  /** A missing APR shown as 0.00% is a claim that the owner borrows for free. */
  /**
   * The second rate boundary, and the second money one: the prefilled terms form. Basis points
   * in the APR box read as a 525% loan *and* get stored as one on the next unrelated edit.
   */
  it('prefills the terms form in the units the form submits, not in stored integers', async () => {
    asOwner()

    const inputs = inputsByName(await DebtsPage())

    expect(inputs.apr.defaultValue).toBe(5.25)
    expect(inputs.apr.defaultValue).not.toBe(525)
    expect(inputs.minimum.defaultValue).toBe(412.5)
    expect(inputs.minimum.defaultValue).not.toBe(41250)
    expect(inputs.targetPayoff.defaultValue).toBe('2029-06-01')
    // The hidden field addresses the row the write lands on. The account's *name* here posts
    // terms against something that is not an id at all.
    expect(inputs.accountId.value).toBe('acct-car')
  })

  /**
   * The harm those defaults cause, end to end, as the owner meets it: open `/debts`, change
   * only the payoff date, press Save. Everything else is posted back exactly as it was
   * prefilled — so if the boxes hold stored integers, saving multiplies the APR and the
   * payment by a hundred, and does it again on every subsequent save.
   */
  it('re-saves untouched fields unchanged instead of multiplying them by a hundred', async () => {
    asOwner()
    const tree = await DebtsPage()
    const inputs = inputsByName(tree)
    const [saveTerms] = formActions(tree)

    await saveTerms(form({
      accountId: String(inputs.accountId.value),
      apr: String(inputs.apr.defaultValue),
      minimum: String(inputs.minimum.defaultValue),
      targetPayoff: '2030-01-01', // the one field the owner actually touched
    }))

    expect(setDebtTerms).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acct-car',
      aprPercent: 5.25,
      minimumPaymentDollars: 412.5,
      targetPayoff: '2030-01-01',
    })
  })

  it('leaves the terms form empty for a debt that has none, rather than prefilling zeroes', async () => {
    asOwner()
    loadDebtsAndGoals.mockResolvedValue(loaded({ debts: [{ ...carLoan, terms: null }] }))

    const inputs = inputsByName(await DebtsPage())

    // Not `0`: a zero in the box is a 0.00% APR one keystroke away from being saved as fact.
    expect(inputs.apr.defaultValue).toBe('')
    expect(inputs.minimum.defaultValue).toBe('')
    expect(inputs.targetPayoff.defaultValue).toBe('')
  })

  it('says no terms are set rather than showing a zero rate', async () => {
    asOwner()
    loadDebtsAndGoals.mockResolvedValue(loaded({ debts: [{ ...carLoan, terms: null }] }))

    const text = textByKey(await DebtsPage(), 'li')['acct-car']

    expect(text).not.toContain('0.00%')
    expect(text).toMatch(/no terms/i)
  })
})

describe('the debts page renders goal progress', () => {
  it('shows saved against target in dollars, with the percentage of the way there', async () => {
    asOwner()

    const text = textByKey(await DebtsPage(), 'li')['goal-ef']

    // One substring, not two independent `toContain`s: asserted separately, swapping the two
    // `formatCents` calls renders "$15,000.00 / $6,000.00 (40%)" — a goal 250% overshot,
    // reported as 40% — and both assertions still pass.
    expect(text).toContain('$6,000.00 / $15,000.00')
    expect(text).not.toContain('600000')
    expect(text).not.toContain('1500000')
    // $6,000 of $15,000. Divided the other way up it reads 250% — a goal already smashed.
    expect(text).toContain('40%')
    expect(text).not.toContain('250%')
  })

  /**
   * Unknown progress is not zero progress. `$0.00 / $15,000.00 (0%)` tells the owner they have
   * saved nothing towards a goal that nothing here is even measuring.
   */
  it('says progress is untracked for a goal with no linked account', async () => {
    asOwner()
    loadDebtsAndGoals.mockResolvedValue(loaded({
      goals: [{ ...emergencyFund, linkedAccountId: null, saved: null }],
    }))

    const text = textByKey(await DebtsPage(), 'li')['goal-ef']

    expect(text).not.toContain('$0.00')
    expect(text).not.toContain('0%')
    expect(text).toContain('$15,000.00')
    expect(text).toMatch(/no linked account/i)
  })

  it('says so when a linked account has not been snapshotted yet', async () => {
    asOwner()
    loadDebtsAndGoals.mockResolvedValue(loaded({
      goals: [{ ...emergencyFund, saved: null }],
    }))

    const text = textByKey(await DebtsPage(), 'li')['goal-ef']

    expect(text).not.toContain('0%')
    expect(text).toMatch(/no balance/i)
  })

  /**
   * `addGoal` refuses a target of zero precisely because it is this denominator, but a row
   * predating that guard would divide by it: `Math.round(600000 / 0 * 100)` is `Infinity`, and
   * the page would render "Infinity%".
   */
  it('renders no percentage at all rather than dividing by a zero target', async () => {
    asOwner()
    loadDebtsAndGoals.mockResolvedValue(loaded({
      goals: [{ ...emergencyFund, targetAmount: 0 }],
    }))

    const text = textByKey(await DebtsPage(), 'li')['goal-ef']

    expect(text).not.toContain('Infinity')
    expect(text).not.toContain('NaN')
  })

  it('shows the date a goal is aiming at', async () => {
    asOwner()

    expect(textByKey(await DebtsPage(), 'li')['goal-ef']).toContain('2027-01-01')
  })
})

describe('the debts page on an empty install', () => {
  it('says why there are no debts instead of showing an empty list', async () => {
    asOwner()
    loadDebtsAndGoals.mockResolvedValue(loaded({ debts: [] }))

    const tree = await DebtsPage()

    expect(findAll(tree, 'li')).toHaveLength(1) // the one goal, and no debt rows
    expect(textOf(tree)).toMatch(/no accounts on the liability side/i)
  })

  it('says there are no goals yet instead of showing an empty list', async () => {
    asOwner()
    loadDebtsAndGoals.mockResolvedValue(loaded({ goals: [] }))

    const tree = await DebtsPage()

    expect(findAll(tree, 'li')).toHaveLength(1) // the one debt, and no goal rows
    expect(textOf(tree)).toMatch(/no goals yet/i)
  })

  /**
   * The goal form must survive an install with no accounts at all — its account picker has a
   * "no linked account" option of its own, so unlike the assets page's revalue dropdown it
   * never submits against an empty list.
   */
  it('still offers the goal form when there is nothing at all to show', async () => {
    asOwner()
    loadDebtsAndGoals.mockResolvedValue({ debts: [], goals: [], accountOptions: [] })

    const actions = formActions(await DebtsPage())

    expect(actions).toHaveLength(1)
    await actions[0](form({ name: 'Emergency fund', target: '15000' }))
    expect(addGoal).toHaveBeenCalledTimes(1)
    expect(setDebtTerms).not.toHaveBeenCalled()
  })
})

describe('the debts page’s Server Actions check the caller too', () => {
  it('writes nothing when an action is invoked by someone who is not the owner', async () => {
    asOwner()
    const actions = formActions(await DebtsPage())
    expect(actions).toHaveLength(2) // one terms form, one goal form

    // The page rendered for the owner; the POST arrives from someone else. Nothing about the
    // earlier render may carry over into the write.
    auth.mockResolvedValue({ sessionClaims: { email: 'someone@else.com' } })

    for (const action of actions) {
      await expect(action(form({
        accountId: 'acct-car', apr: '5.25', minimum: '412.50',
        name: 'Emergency fund', target: '15000',
      }))).rejects.toThrow(/owner/i)
    }

    expect(setDebtTerms).not.toHaveBeenCalled()
    expect(addGoal).not.toHaveBeenCalled()
  })

  it('saves terms as a percentage and dollars, leaving basis points and cents to the action', async () => {
    asOwner()
    const [saveTerms] = formActions(await DebtsPage())

    await saveTerms(form({
      accountId: 'acct-car', apr: '4.5', minimum: '400.25', targetPayoff: '2029-06-01',
    }))

    expect(setDebtTerms).toHaveBeenCalledWith({ marker: 'test-db-handle' }, {
      accountId: 'acct-car', aprPercent: 4.5, minimumPaymentDollars: 400.25,
      targetPayoff: '2029-06-01',
    })
    expect(revalidatePath).toHaveBeenCalledWith('/debts')
  })

  it('treats an empty payoff date as no payoff date, not as the empty string', async () => {
    asOwner()
    const [saveTerms] = formActions(await DebtsPage())

    // An untouched `<input type="date">` submits "". Passed through it reaches a `date` column
    // as an invalid-input driver error.
    await saveTerms(form({ accountId: 'acct-car', apr: '4.5', minimum: '400.25', targetPayoff: '' }))

    expect(setDebtTerms).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ targetPayoff: null }))
  })

  it('adds a goal from the form, in dollars, leaving cents to the action module', async () => {
    asOwner()
    const [, createGoal] = formActions(await DebtsPage())

    await createGoal(form({
      name: 'Emergency fund', target: '15000', targetDate: '2027-01-01',
      linkedAccountId: 'acct-savings',
    }))

    expect(addGoal).toHaveBeenCalledWith({ marker: 'test-db-handle' }, {
      name: 'Emergency fund', targetAmountDollars: 15000, targetDate: '2027-01-01',
      linkedAccountId: 'acct-savings',
    })
    expect(revalidatePath).toHaveBeenCalledWith('/debts')
  })

  it('treats an unset date and an unselected account as absent', async () => {
    asOwner()
    const [, createGoal] = formActions(await DebtsPage())

    await createGoal(form({ name: 'Holiday', target: '3000', targetDate: '', linkedAccountId: '' }))

    expect(addGoal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetDate: null, linkedAccountId: null,
    }))
  })

  /**
   * `Number('')` is **0**, not NaN — as are `Number(null)` and `Number('  ')`. Only junk text
   * is NaN. So every guard of the form "refuse NaN and negatives" waves a blank field through
   * as a legitimate zero, and a blank APR box is stored as a 0.00% loan with a $0.00 minimum
   * payment: the exact line this page reserves for a debt whose terms have never been set.
   * The distinction between "blank" and "zero" only survives at the form boundary, so that is
   * where it has to be made.
   */
  it('refuses a blank APR or payment rather than storing a 0.00% loan', async () => {
    asOwner()
    const [saveTerms] = formActions(await DebtsPage())
    const filled = { accountId: 'acct-car', apr: '5.25', minimum: '412.50' }

    await expect(saveTerms(form({ ...filled, apr: '' }))).rejects.toThrow(/APR is required/i)
    await expect(saveTerms(form({ ...filled, apr: '   ' }))).rejects.toThrow(/APR is required/i)
    await expect(saveTerms(form({ ...filled, minimum: '' })))
      .rejects.toThrow(/minimum payment is required/i)
    // A POST that simply omits the field, which no browser sends but any client may.
    await expect(saveTerms(form({ apr: '5.25', minimum: '412.50' })))
      .rejects.toThrow(/account is required/i)

    expect(setDebtTerms).not.toHaveBeenCalled()
  })

  it('still accepts a zero the owner typed on purpose', async () => {
    asOwner()
    const [saveTerms] = formActions(await DebtsPage())

    // An interest-free loan is real — a 0% car finance deal, a family loan. The rule is
    // "filled in", not "non-zero", and conflating the two would refuse a legitimate entry.
    await saveTerms(form({ accountId: 'acct-car', apr: '0', minimum: '250' }))

    expect(setDebtTerms).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ aprPercent: 0, minimumPaymentDollars: 250 }))
  })

  it('refuses a goal with a blank name or target rather than inventing one', async () => {
    asOwner()
    const [, createGoal] = formActions(await DebtsPage())

    await expect(createGoal(form({ name: '', target: '15000' })))
      .rejects.toThrow(/goal name is required/i)
    await expect(createGoal(form({ name: 'Emergency fund', target: '' })))
      .rejects.toThrow(/target amount is required/i)
    // `String(formData.get('name'))` on an absent field is the four characters "null" — a
    // goal named after a JavaScript value.
    await expect(createGoal(form({ target: '15000' })))
      .rejects.toThrow(/goal name is required/i)

    expect(addGoal).not.toHaveBeenCalled()
  })

  /**
   * The goal form's account picker offers every account, not only the liabilities the plan
   * listed. A savings goal linked to a car loan measures progress against a debt.
   */
  it('offers every account to link a goal to, not only the liabilities', async () => {
    asOwner()

    const options = findAll(await DebtsPage(), 'option').map((o) => String(o.props?.children ?? ''))

    expect(options).toContain('Savings')
    expect(options).toContain('Car Loan')
  })
})
