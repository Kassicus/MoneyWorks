import { describe, it, expect } from 'vitest'
import { chartDates, netWorthOn, netWorthSeries } from '@/lib/net-worth'
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

  it('picks the latest date, not the largest balance, whatever order the rows arrive in', () => {
    // Descending input order, and the later date holds the SMALLER balance — a falling
    // balance, which is exactly the case a "take the max value" or "take the last row"
    // shortcut would get wrong.
    const snaps = [
      snap('checking', true, '2026-08-05', 300_00),
      snap('checking', true, '2026-08-01', 500_00),
    ]
    expect(netWorthOn('2026-08-09', snaps, [])).toBe(300_00)
    expect(netWorthOn('2026-08-03', snaps, [])).toBe(500_00)
  })

  it('sums accounts and manual assets together', () => {
    const snaps = [
      snap('checking', true, '2026-08-01', 500_00),
      snap('visa', false, '2026-08-01', 200_00),
    ]
    const manual: ManualAssetValue[] = [
      { name: 'House', isAsset: true, asOf: '2026-07-01', value: 400_000_00 },
      { name: 'Mortgage', isAsset: false, asOf: '2026-07-01', value: 250_000_00 },
    ]
    expect(netWorthOn('2026-08-01', snaps, manual)).toBe(150_300_00)
  })

  it('takes the later createdAt when a same-day revaluation ties on asOf', () => {
    // Value the house in the morning, correct it in the afternoon: same name, same as_of.
    const morning: ManualAssetValue = {
      name: 'House',
      isAsset: true,
      asOf: '2026-08-01',
      value: 400_000_00,
      createdAt: '2026-08-01T09:00:00.000Z',
    }
    const afternoon: ManualAssetValue = {
      name: 'House',
      isAsset: true,
      asOf: '2026-08-01',
      value: 420_000_00,
      createdAt: '2026-08-01T15:00:00.000Z',
    }
    // Neither input order may change the answer — the tiebreak is on the data, not the
    // ORDER BY of whichever query produced the rows.
    expect(netWorthOn('2026-08-01', [], [morning, afternoon])).toBe(420_000_00)
    expect(netWorthOn('2026-08-01', [], [afternoon, morning])).toBe(420_000_00)
  })

  it('falls back to the last row in input order when a same-day tie has no createdAt', () => {
    const first: ManualAssetValue = { name: 'House', isAsset: true, asOf: '2026-08-01', value: 400_000_00 }
    const second: ManualAssetValue = { name: 'House', isAsset: true, asOf: '2026-08-01', value: 420_000_00 }
    expect(netWorthOn('2026-08-01', [], [first, second])).toBe(420_000_00)
    expect(netWorthOn('2026-08-01', [], [second, first])).toBe(400_000_00)
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

  it('answers the dates as given, out of order and repeats included', () => {
    const snaps = [
      snap('checking', true, '2026-08-01', 100_00),
      snap('checking', true, '2026-08-03', 300_00),
    ]
    expect(netWorthSeries(['2026-08-03', '2026-08-01', '2026-08-03'], snaps, [])).toEqual([
      { date: '2026-08-03', netWorth: 300_00 },
      { date: '2026-08-01', netWorth: 100_00 },
      { date: '2026-08-03', netWorth: 300_00 },
    ])
  })
})

describe('chartDates', () => {
  const manual = (asOf: string): ManualAssetValue =>
    ({ name: 'House', isAsset: true, asOf, value: 400_000_00 })

  it('runs one point per day from the first date with data through today', () => {
    const snaps = [snap('checking', true, '2026-08-10', 100_00)]
    expect(chartDates(snaps, [], '2026-08-13')).toEqual([
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
    ])
  })

  it('starts at the earliest date across snapshots and manual assets alike', () => {
    const snaps = [snap('checking', true, '2026-08-12', 100_00)]
    expect(chartDates(snaps, [manual('2026-08-11')], '2026-08-13')).toEqual([
      '2026-08-11', '2026-08-12', '2026-08-13',
    ])
  })

  it('never starts before the first real data, so day one is a dot and not a cliff', () => {
    // `netWorthOn` answers 0 for every date before the first snapshot. A fixed trailing
    // window would therefore draw a line climbing out of $0 on a brand-new install and read
    // as real history. The chart begins where the data begins.
    const snaps = [snap('checking', true, '2026-08-13', 100_00)]
    expect(chartDates(snaps, [], '2026-08-13')).toEqual(['2026-08-13'])
  })

  it('is a single point when there is no data at all', () => {
    expect(chartDates([], [], '2026-08-13')).toEqual(['2026-08-13'])
  })

  it('caps the window by dropping the OLDEST days, so today is always the last point', () => {
    // The cap must trim the far end, not the near one. Capping forward from the earliest
    // date would freeze the chart on the 365th day of use: the headline number would keep
    // moving while the line stopped, and the right edge of the chart would silently stop
    // meaning "today".
    const snaps = [snap('checking', true, '2020-01-01', 100_00)]
    const dates = chartDates(snaps, [], '2026-08-13', 5)
    expect(dates).toEqual(['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'])
  })

  it('defaults to at most a year of points', () => {
    const snaps = [snap('checking', true, '2020-01-01', 100_00)]
    const dates = chartDates(snaps, [], '2026-08-13')
    expect(dates).toHaveLength(365)
    expect(dates.at(-1)).toBe('2026-08-13')
    expect(dates[0]).toBe('2025-08-14')
  })

  it('spans a leap day without losing or repeating one', () => {
    const snaps = [snap('checking', true, '2028-02-27', 100_00)]
    expect(chartDates(snaps, [], '2028-03-01')).toEqual([
      '2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01',
    ])
  })

  it('is a single point when every date in the data is in the future', () => {
    // A manual asset can be dated forward. It contributes nothing to today's net worth, so
    // charting from its `as_of` would mean an empty range or a run of zeroes.
    expect(chartDates([], [manual('2027-01-01')], '2026-08-13')).toEqual(['2026-08-13'])
  })
})
