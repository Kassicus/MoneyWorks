import { describe, it, expect } from 'vitest'
import { normalizeAccountsResponse } from '@/sync/simplefin'
import fixture from '../fixtures/simplefin-accounts.json'

describe('normalizeAccountsResponse', () => {
  const { accounts, transactions } = normalizeAccountsResponse(fixture)

  it('converts balances to integer cents', () => {
    expect(accounts.find((a) => a.simplefinId === 'acct-checking')!.balance).toBe(154327)
  })

  it('classifies a negative balance as a liability and stores a positive magnitude', () => {
    const visa = accounts.find((a) => a.simplefinId === 'acct-visa')!
    expect(visa.isAsset).toBe(false)
    expect(visa.balance).toBe(89210)
  })

  it('keeps the natural sign on transaction amounts', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-1')!.amount).toBe(-4550)
  })

  it('converts posted epoch seconds to an ISO date', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-1')!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('links each transaction to its account', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-2')!.simplefinAccountId).toBe('acct-visa')
  })
})
