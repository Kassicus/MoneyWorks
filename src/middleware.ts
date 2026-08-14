import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { isAllowedEmail } from '@/lib/auth'

// Exempt from the *Clerk session* check only. Vercel Cron sends no cookies, so
// `/api/sync` authenticates with the CRON_SECRET bearer token in its own route
// handler — it is not an unauthenticated route. The sign-in/sign-up routes must
// be reachable signed-out or there is no way to sign in.
const isPublic = createRouteMatcher(['/api/sync', '/sign-in(.*)', '/sign-up(.*)'])

export default clerkMiddleware(async (auth, req) => {
  if (isPublic(req)) return

  const { userId, sessionClaims, redirectToSignIn } = await auth()
  if (!userId) return redirectToSignIn()

  // Requires `email` to be added to the session token claims in the Clerk
  // dashboard; absent the claim this denies everyone, which is the safe failure.
  const email = (sessionClaims as { email?: string } | null)?.email
  if (!isAllowedEmail(email)) {
    return new NextResponse('Forbidden', { status: 403 })
  }
})

export const config = {
  // Excluding *every* path containing a dot would also exclude the RSC payload
  // URLs Next serves for app pages (`/dashboard.rsc`, `/dashboard.segments/…`,
  // `/_next/data/…json`) — i.e. the rendered page data, reachable without the
  // allowlist check. So the exclusion is an explicit list of static-asset
  // extensions (Clerk's documented matcher) instead. Everything that renders or
  // returns app data is covered; only build output and static files are not.
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/api(.*)',
  ],
}
