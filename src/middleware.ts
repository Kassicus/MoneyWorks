import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { ownerEmail } from '@/lib/auth'

// Exempt from the *Clerk session* check only. Vercel Cron sends no cookies, so
// `/api/sync` authenticates with the CRON_SECRET bearer token in its own route
// handler — it is not an unauthenticated route. The sign-in/sign-up routes must
// be reachable signed-out or there is no way to sign in.
//
// `(/.*)?` and not `(.*)`: the latter is a prefix match, so it would also exempt
// /sign-invoices, /sign-in-report and /sign-upgrade. Whole segments only.
const isPublic = createRouteMatcher(['/api/sync', '/sign-in(/.*)?', '/sign-up(/.*)?'])

export default clerkMiddleware(async (auth, req) => {
  if (isPublic(req)) return

  const { userId, sessionClaims, redirectToSignIn } = await auth()
  if (!userId) return redirectToSignIn()

  // Requires `email` to be added to the session token claims in the Clerk
  // dashboard; absent the claim this denies everyone, which is the safe failure.
  // The claim is decoded by `ownerEmail` rather than cast here, so this file and
  // the dashboard page cannot disagree about what a valid claim looks like.
  if (!ownerEmail(sessionClaims)) {
    return new NextResponse('Forbidden', { status: 403 })
  }
})

export const config = {
  // Excluding *every* path containing a dot would also exclude the RSC payload
  // URLs Next serves for app pages (`/dashboard.rsc`, `/dashboard.segments/…`,
  // `/_next/data/…json`) — i.e. the rendered page data, reachable without the
  // allowlist check. So the exclusion is an explicit list of static-asset
  // extensions instead. Everything that renders or returns app data is covered;
  // only build output and static files are not.
  //
  // The list is short because **every extension in it is a suffix that puts a
  // path outside the auth boundary**, and nothing warns when one starts
  // matching something real: Clerk's documented matcher excludes csv/doc/xls/
  // zip, so an export route added later at `/transactions.csv` would serve the
  // owner's transactions to anyone, with nothing in that diff to say so. The
  // same argument retires html/jpeg/webp/png/gif/ttf/woff2/webmanifest, none of
  // which this app serves either — an unused exclusion is a hole waiting for a
  // file, not a spare part.
  //
  // What is actually served statically: `public/` holds five `.svg` files, and
  // `src/app/favicon.ico` is served at `/favicon.ico`. Built CSS and JS live
  // under `/_next/static/`, which the `_next` alternative already excludes.
  matcher: [
    '/((?!_next|[^?]*\\.(?:svg|ico)).*)',
    '/api(.*)',
  ],
}
