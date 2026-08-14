/**
 * MoneyWorks is single-user. Clerk proves a visitor is *some* signed-in person;
 * this proves they are *the* person. One email, one comparison, no I/O — so the
 * decision that guards the owner's finances can be tested exhaustively.
 */
export function isAllowedEmail(email: string | null | undefined): boolean {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  // Fail closed: an unset (or blank) ALLOWED_EMAIL denies everyone. A misconfigured
  // deploy must lock the owner out, never let the internet in.
  if (!allowed) return false
  if (!email) return false
  return email.trim().toLowerCase() === allowed
}
