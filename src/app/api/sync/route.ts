import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { isAuthorizedCronRequest } from '@/lib/cron-auth'
import { runSyncJob } from '@/sync/job'

/**
 * The nightly sync, triggered by the Vercel Cron entry in `vercel.json` at 09:00 UTC.
 *
 * This is the one route exempted from the Clerk middleware, because Vercel Cron sends no
 * session cookie. Exempt from the *session* check, not from authentication: the
 * `CRON_SECRET` bearer token below is the entire access control on a job that reads the
 * owner's bank, and it runs before anything else — before a secret is decrypted, before the
 * network is touched, before a `sync_runs` row exists. See `lib/cron-auth.ts` for why the
 * comparison is not the obvious template-string one.
 *
 * **GET is the method that matters.** Vercel triggers a cron job with an HTTP GET request;
 * a POST-only handler would answer every nightly invocation with 405 and the dashboard would
 * quietly go stale. POST is kept because it is the honest verb for a job that writes, and it
 * is what the manual `curl` check uses.
 */

// Load-bearing now that GET is exported: Next evaluates static GET route handlers at build
// time, and a sync must never run as a side effect of a deploy.
export const dynamic = 'force-dynamic'

async function handle(req: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(req.headers.get('authorization'))) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  // Everything below the auth check — including error recording — lives in `runSyncJob`,
  // which never lets a credential into the string it returns.
  const result = await runSyncJob(db)
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}

export async function GET(req: Request): Promise<NextResponse> {
  return handle(req)
}

export async function POST(req: Request): Promise<NextResponse> {
  return handle(req)
}
