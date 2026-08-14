import { describe, it, expect } from 'vitest'
import { netWorthOn, netWorthSeries } from '@/lib/net-worth'
import type { AccountBalance, ManualAssetValue } from '@/lib/net-worth'

const snap = (accountId: string, isAsset: boolean, date: string, balance: number): AccountBalance =>
  ({ accountId, isAsset, date, balance })

describe('netWorthOn', () => {
  it('subtracts liabilities, which are stored as positive magnitudes', () => {
    const snaps = [
      snap('checking', true, '2026-08-01', 500_00),
      snap('visa', false, '2026-08-01', 200_00),
    ]
    expect(netWorthOn('2026-08-01', snaps, [])).toBe(300_00)
  })

  it('carries forward the most recent snapshot on or before the date', () => {
    const snaps = [
      snap('checking', true, '2026-08-01', 500_00),
      snap('checking', true, '2026-08-05', 700_00),
    ]
    expect(netWorthOn('2026-08-03', snaps, [])).toBe(500_00)
    expect(netWorthOn('2026-08-05', snaps, [])).toBe(700_00)
    expect(netWorthOn('2026-08-09', snaps, [])).toBe(700_00)
  })

  it('treats an account with no snapshot yet as zero rather than erroring', () => {
    const snaps = [snap('checking', true, '2026-08-05', 700_00)]
    expect(netWorthOn('2026-08-01', snaps, [])).toBe(0)
  })

  it('counts only the most recent valuation of a revalued asset', () => {
    // Two rows for the same house — a revaluation, not two houses.
    const manual: ManualAssetValue[] = [
      { name: 'House', isAsset: true, asOf: '2026-01-01', value: 400_000_00 },
      { name: 'House', isAsset: true, asOf: '2026-07-01', value: 420_000_00 },
      { name: 'Mortgage', isAsset: false, asOf: '2026-07-01', value: 250_000_00 },
    ]
    expect(netWorthOn('2026-03-01', [], manual)).toBe(400_000_00)
    expect(netWorthOn('2026-08-01', [], manual)).toBe(170_000_00)
  })

  it('returns zero when there is no data at all', () => {
    expect(netWorthOn('2026-08-01', [], [])).toBe(0)
  })
})

describe('netWorthSeries', () => {
  it('produces one point per requested date', () => {
    const snaps = [
      snap('checking', true, '2026-08-01', 100_00),
      snap('checking', true, '2026-08-03', 300_00),
    ]
    expect(netWorthSeries(['2026-08-01', '2026-08-02', '2026-08-03'], snaps, [])).toEqual([
      { date: '2026-08-01', netWorth: 100_00 },
      { date: '2026-08-02', netWorth: 100_00 },
      { date: '2026-08-03', netWorth: 300_00 },
    ])
  })
})
