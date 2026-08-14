import { timingSafeEqual } from 'node:crypto'

/**
 * The whole authentication of `POST/GET /api/sync`.
 *
 * That route is exempt from the Clerk middleware because Vercel Cron sends no session
 * cookie — it is *not* exempt from authentication. This shared secret is all that stands
 * between the internet and a job that talks to the owner's bank, so the check lives in its
 * own module with its own tests rather than inline in the handler.
 *
 * Deliberately not in `lib/auth.ts`: that module is imported by `src/middleware.ts`, which
 * Next bundles for the Edge runtime, and `node:crypto` is not fully available there.
 *
 * ## Fail closed
 *
 * The obvious spelling — `header !== \`Bearer ${process.env.CRON_SECRET}\`` — compares
 * against the literal string `"Bearer undefined"` when the variable is missing. A deploy
 * that forgot to set `CRON_SECRET` would then accept a password anyone can guess. An unset,
 * empty, or blank secret must authenticate nobody.
 *
 * ## No normalisation
 *
 * Vercel sends `Bearer ` followed by the environment variable byte for byte. Trimming or
 * lower-casing either side to be forgiving would reject the platform's own request when the
 * configured secret happens to carry whitespace, and the sync would silently stop running.
 * The comparison is exact, on the full header value.
 */
export function isAuthorizedCronRequest(header: string | null | undefined): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret || secret.trim() === '') return false
  if (!header) return false

  const expected = Buffer.from(`Bearer ${secret}`, 'utf8')
  const actual = Buffer.from(header, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, so the length is compared first and does
  // leak — the constant-time property covers the secret's contents, not its size.
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}
