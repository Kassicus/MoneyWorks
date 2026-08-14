import { describe, it, expect } from 'vitest'
import {
  dollarsToCents, centsToDollars, formatCents, percentToBps, bpsToPercent,
} from '@/lib/money'

describe('money', () => {
  it('converts dollars to cents without float drift', () => {
    expect(dollarsToCents(19.99)).toBe(1999)
    expect(dollarsToCents(0.1 + 0.2)).toBe(30)
    expect(dollarsToCents(-45.5)).toBe(-4550)
  })

  it('converts cents back to dollars', () => {
    expect(centsToDollars(1999)).toBe(19.99)
  })

  it('formats cents as USD', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(-4550)).toBe('-$45.50')
    expect(formatCents(0)).toBe('$0.00')
  })
})

describe('rates', () => {
  it('converts a percentage to integer basis points', () => {
    expect(percentToBps(5.25)).toBe(525)
    // `apr_bps` is an integer column: unmultiplied this is 5, a quarter point off a mortgage.
    expect(percentToBps(0)).toBe(0)
    expect(percentToBps(22.99)).toBe(2299)
    // Sub-basis-point precision is not representable and is rounded, not truncated.
    expect(percentToBps(6.875)).toBe(688)
  })

  it('converts basis points back to a percentage', () => {
    expect(bpsToPercent(525)).toBe(5.25)
    expect(bpsToPercent(0)).toBe(0)
  })

  it('round-trips a rate the owner typed', () => {
    // The form shows `bpsToPercent`, the owner presses Save without touching it, and
    // `percentToBps` stores it again. Anything but the identity here inflates the stored APR
    // by a factor of a hundred every time the page is saved.
    for (const percent of [0, 4, 5.25, 6.88, 22.99]) {
      expect(percentToBps(bpsToPercent(percentToBps(percent)))).toBe(percentToBps(percent))
    }
  })
})
