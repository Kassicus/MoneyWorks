import { describe, it, expect } from 'vitest'
import { requiredText, requiredNumber, optionalText } from '@/lib/form'

/**
 * The one fact this module exists for, asserted first so the rest reads as consequence:
 * `Number('')` is 0, not NaN. Every "refuse NaN and negatives" guard in this codebase admits a
 * blank field as a legitimate zero unless a blank is stopped before it becomes a number.
 */
const form = (entries: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(entries)) fd.set(k, v)
  return fd
}

describe('the blank-field trap this module exists to close', () => {
  it('is real: an empty, absent or whitespace field is 0 to Number, not NaN', () => {
    expect(Number('')).toBe(0)
    expect(Number(null)).toBe(0)
    expect(Number('   ')).toBe(0)
    // Only junk *text* is NaN, which is the half every existing guard already catches.
    expect(Number('abc')).toBeNaN()
  })
})

describe('requiredNumber', () => {
  it('reads the number the owner typed', () => {
    expect(requiredNumber(form({ apr: '5.25' }), 'apr', 'An APR')).toBe(5.25)
    // Zero typed on purpose is a number, and stays one. The rule is "filled in", not "truthy".
    expect(requiredNumber(form({ apr: '0' }), 'apr', 'An APR')).toBe(0)
  })

  it('refuses a blank, whitespace-only or absent field instead of calling it zero', () => {
    for (const fd of [form({ apr: '' }), form({ apr: '   ' }), form({})]) {
      expect(() => requiredNumber(fd, 'apr', 'An APR')).toThrow(/An APR is required/)
    }
  })

  it('passes junk text on as NaN, for the action’s own validator to refuse', () => {
    // Deliberately not refused here: which numbers are valid is a question about APRs and
    // valuations, and the answer already lives beside the SQL that stores them.
    expect(requiredNumber(form({ apr: 'abc' }), 'apr', 'An APR')).toBeNaN()
  })
})

describe('requiredText', () => {
  it('trims what it returns', () => {
    expect(requiredText(form({ name: '  Emergency fund  ' }), 'name', 'A name')).toBe('Emergency fund')
  })

  it('refuses an absent field rather than returning the string "null"', () => {
    // `String(formData.get('name'))` on an absent field is the four characters n-u-l-l: a
    // valid-looking goal name, account id or date that means nothing.
    expect(() => requiredText(form({}), 'name', 'A name')).toThrow(/A name is required/)
  })
})

describe('optionalText', () => {
  it('reads a value that is there', () => {
    expect(optionalText(form({ targetDate: '2027-01-01' }), 'targetDate')).toBe('2027-01-01')
  })

  it('answers null for the empty string an untouched date or select submits', () => {
    expect(optionalText(form({ targetDate: '' }), 'targetDate')).toBeNull()
    expect(optionalText(form({}), 'targetDate')).toBeNull()
  })
})
