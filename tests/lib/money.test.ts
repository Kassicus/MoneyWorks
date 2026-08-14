import { describe, it, expect } from 'vitest'
import { dollarsToCents, centsToDollars, formatCents } from '@/lib/money'

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
