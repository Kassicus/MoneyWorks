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

/**
 * The owner's address if these session claims belong to the owner, otherwise null.
 *
 * The one place that knows the shape of a Clerk session token. Both callers — the middleware
 * and the dashboard page — go through here rather than each casting `sessionClaims` to
 * `{ email?: string }`, because two copies of a security-relevant cast drift apart and only
 * one of them gets fixed.
 *
 * `unknown` in, and every non-string claim answered with null rather than a thrown
 * `TypeError`: a claim template can be misconfigured to yield an array or an object, and the
 * right response to that is a denial, not a 500. The value returned is the claim verbatim,
 * not a trimmed or lowercased copy — normalisation belongs to the comparison.
 */
export function ownerEmail(sessionClaims: unknown): string | null {
  if (typeof sessionClaims !== 'object' || sessionClaims === null) return null
  const email = (sessionClaims as { email?: unknown }).email
  if (typeof email !== 'string') return null
  return isAllowedEmail(email) ? email : null
}
