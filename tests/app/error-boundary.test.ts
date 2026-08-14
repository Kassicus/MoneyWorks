import { describe, it, expect, vi } from 'vitest'
import AppError from '@/app/(app)/error'
import { textOf, findAll } from '../helpers/element-tree'

/**
 * Without this boundary every guard in `assets/actions.ts` — a duplicate name, a blank name, a
 * negative value, a caller who is not the owner — reaches the browser as an unhandled
 * exception and takes the page with it. Two things are worth pinning: that there is a way
 * back, and that the boundary does not print what it was handed.
 */
describe('the app error boundary', () => {
  const boom = Object.assign(
    new Error('duplicate key value violates unique constraint: insert into "manual_assets" ' +
      '("name","value") values (\'Joint chequing\', 1234567)'),
    { digest: 'abc123' },
  )

  it('offers a way back that calls reset', () => {
    const reset = vi.fn()
    const [button] = findAll(AppError({ error: boom, reset }), 'button')

    expect(button).toBeDefined()
    ;(button.props!.onClick as () => void)()
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('prints the digest but never the error message', () => {
    const text = textOf(AppError({ error: boom, reset: () => {} }))

    // The same rule that keeps `sync_runs.error` out of the dashboard's query: a throw from
    // the data layer is a drizzle error, and drizzle embeds the failing SQL with its bound
    // parameters — account names, balances — in the message.
    expect(text).not.toContain('manual_assets')
    expect(text).not.toContain('Joint chequing')
    expect(text).not.toContain('1234567')
    // The digest is the key to the same error in the function logs, and is safe to show.
    expect(text).toContain('abc123')
  })

  it('says something useful when there is no digest', () => {
    const text = textOf(AppError({ error: new Error('nope'), reset: () => {} }))

    expect(text).toContain('That did not work')
    expect(text).not.toContain('nope')
    // No dangling "Reference " with nothing after it.
    expect(text).not.toContain('Reference')
  })
})
