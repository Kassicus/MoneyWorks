/**
 * The `FormData` boundary. Every value a Server Action reads from a form comes through here.
 *
 * The reason this module exists is one JavaScript fact that is easy to write past:
 *
 * ```
 * Number('')     // 0   — not NaN
 * Number(null)   // 0   — not NaN
 * Number('  ')   // 0   — not NaN
 * Number('abc')  // NaN
 * ```
 *
 * So `Number(formData.get('apr'))` answers **0** for a field the owner left blank, for a field
 * a POST omitted entirely, and for a field holding only spaces. Only junk *text* yields NaN.
 * Every guard in this codebase that refuses `NaN` and negatives — `valuationCents`, `rateBps`,
 * `paymentCents` — therefore waves the blank field straight through as a legitimate zero: a
 * 0.00% APR, a $0.00 minimum payment, a house worth nothing. None of those are correctable
 * afterwards on the append-only side, and all of them read as facts on the page.
 *
 * The split of responsibility is: **this module proves a field was filled in; the action module
 * proves the value is usable.** A blank is refused here, with the field's name in the message.
 * Junk text becomes NaN and travels on to the action's own validator, which is where the rule
 * about what a valid APR or valuation is already lives, and which is tested against real SQL.
 */

/** The trimmed text of a required field, or a thrown error when it is absent or blank. */
export function requiredText(formData: FormData, field: string, label: string): string {
  const raw = formData.get(field)
  // Not `String(raw)`: an absent field is null, and `String(null)` is the string "null" — a
  // perfectly valid-looking name, account id, or date that means nothing.
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw new Error(`${label} is required.`)
  return text
}

/**
 * The number in a required field, or a thrown error when it is absent or blank.
 *
 * NaN is returned rather than refused for junk text, deliberately: it is the action module's
 * validator that knows whether this number is an APR, a payment or a valuation, and what each
 * may be.
 */
export function requiredNumber(formData: FormData, field: string, label: string): number {
  return Number(requiredText(formData, field, label))
}

/** The trimmed text of an optional field, or null when it is absent or blank. */
export function optionalText(formData: FormData, field: string): string | null {
  const raw = formData.get(field)
  const text = typeof raw === 'string' ? raw.trim() : ''
  // An untouched `<input type="date">` submits "", and an unselected `<select>` submits its
  // placeholder option's "". Both mean "not set", and both reach a `date` or `uuid` column as
  // a driver error if passed through.
  return text || null
}
