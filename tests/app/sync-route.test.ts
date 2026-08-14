import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SyncJobResult } from '@/sync/job'

/**
 * The route handler itself is three lines of composition over modules with their own suites
 * (`isAuthorizedCronRequest`, `runSyncJob`), so this file tests only what the composition
 * adds and nothing else: that an unauthorized request is rejected *before any work happens*,
 * and that the method Vercel Cron actually sends is wired up.
 *
 * Two module mocks, both structural rather than behavioural:
 * - `@/db/client` calls `neon(process.env.DATABASE_URL!)` at import time, which throws with
 *   no database configured. There is no database in this suite; the handle is only passed
 *   through.
 * - `@/sync/job` is stubbed so "was it called?" is observable. The assertion that matters is
 *   the negative one — on a rejected request it must not have run.
 */

const runSyncJob = vi.fn<(...args: unknown[]) => Promise<SyncJobResult>>(async () => ({
  ok: true,
  accountsSeen: 2,
  transactionsSeen: 3,
}))

vi.mock('@/db/client', () => ({ db: { marker: 'test-db-handle' } }))
vi.mock('@/sync/job', () => ({ runSyncJob }))

const { GET, POST } = await import('@/app/api/sync/route')

const SECRET = 'a-real-looking-cron-secret-8f2c'
const authorized = (method: 'GET' | 'POST' = 'POST') =>
  new Request('https://moneyworks.test/api/sync', {
    method,
    headers: { authorization: `Bearer ${SECRET}` },
  })

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  runSyncJob.mockClear()
})

afterEach(() => {
  delete process.env.CRON_SECRET
})

describe('POST /api/sync', () => {
  it('runs the sync and reports items seen', async () => {
    const res = await POST(authorized())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, accountsSeen: 2, transactionsSeen: 3 })
    expect(runSyncJob).toHaveBeenCalledTimes(1)
  })

  it('answers 500 when the run failed, so a red cron invocation is visible in Vercel', async () => {
    runSyncJob.mockResolvedValueOnce({ ok: false, error: 'Error: SimpleFIN fetch failed: 403' })

    const res = await POST(authorized())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Error: SimpleFIN fetch failed: 403' })
  })

  it('rejects a bad secret before doing any work', async () => {
    const res = await POST(
      new Request('https://moneyworks.test/api/sync', {
        method: 'POST',
        headers: { authorization: 'Bearer not-the-secret' },
      }),
    )

    expect(res.status).toBe(401)
    // Not merely "returns 401": nothing may be fetched, decrypted, or written first. A
    // rejected request must leave no `sync_runs` row behind.
    expect(runSyncJob).not.toHaveBeenCalled()
  })

  it('rejects a request with no authorization header', async () => {
    const res = await POST(new Request('https://moneyworks.test/api/sync', { method: 'POST' }))

    expect(res.status).toBe(401)
    expect(runSyncJob).not.toHaveBeenCalled()
  })

  it('rejects `Bearer undefined` when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET

    const res = await POST(
      new Request('https://moneyworks.test/api/sync', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    )

    expect(res.status).toBe(401)
    expect(runSyncJob).not.toHaveBeenCalled()
  })
})

describe('GET /api/sync', () => {
  // Vercel Cron triggers a job with an HTTP **GET**. A POST-only route would answer the
  // nightly invocation with 405 and never sync. This test is the only thing standing between
  // that and a dashboard that quietly stops updating.
  it('is the method Vercel Cron sends, and does the same work', async () => {
    const res = await GET(authorized('GET'))

    expect(res.status).toBe(200)
    expect(runSyncJob).toHaveBeenCalledTimes(1)
  })

  it('is authenticated exactly like POST', async () => {
    const res = await GET(new Request('https://moneyworks.test/api/sync'))

    expect(res.status).toBe(401)
    expect(runSyncJob).not.toHaveBeenCalled()
  })
})
