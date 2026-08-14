import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { makeTestDb } from '../helpers/test-db'
import { runSyncJob } from '@/sync/job'
import { getSecret, putSecret } from '@/lib/secrets'
import { accounts, balanceSnapshots, syncRuns, transactions } from '@/db/schema'
import fixture from '../fixtures/simplefin-accounts.json'

// Carries a credential, exactly as a real access URL does. Everything this suite asserts
// about error text is asserted against these two sentinels.
const CREDENTIAL = 's3cret%2Fpass'
const ACCESS_URL = `https://demo-user:${CREDENTIAL}@bridge.example.org/simplefin`
const CLAIM_URL = 'https://bridge.example.org/simplefin/claim/SETUP-TOKEN-SENTINEL'
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64')

const NOW = new Date('2026-08-13T09:00:00.000Z')

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.SIMPLEFIN_SETUP_TOKEN
})

/** Everything a caught error could carry, not just its message. */
const serialize = (e: unknown) => `${String(e)} ${JSON.stringify(e)}`

function stubAccountsFetch(payload: unknown = fixture, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('runSyncJob', () => {
  it('applies the payload and records an ok run', async () => {
    const { db, close } = await makeTestDb()
    try {
      await putSecret(db, 'simplefin_access_url', ACCESS_URL)
      stubAccountsFetch()

      const result = await runSyncJob(db, NOW)

      expect(result).toEqual({ ok: true, accountsSeen: 2, transactionsSeen: 2 })
      expect(await db.select().from(accounts)).toHaveLength(2)
      expect(await db.select().from(transactions)).toHaveLength(2)

      const snapshots = await db.select().from(balanceSnapshots)
      expect(snapshots).toHaveLength(2)
      // The run's date comes from the injected clock, in UTC — not the host's timezone.
      expect(snapshots.every((s) => s.date === '2026-08-13')).toBe(true)

      const [run] = await db.select().from(syncRuns)
      expect(run.status).toBe('ok')
      expect(run.error).toBeNull()
      expect(run.finishedAt).not.toBeNull()
    } finally {
      await close()
    }
  })

  it('asks for a 7-day overlap window, because institutions revise posted transactions', async () => {
    const { db, close } = await makeTestDb()
    try {
      await putSecret(db, 'simplefin_access_url', ACCESS_URL)
      const fetchMock = stubAccountsFetch()

      await runSyncJob(db, NOW)

      const [url] = fetchMock.mock.calls[0] as unknown as [URL]
      const expected = Math.floor(NOW.getTime() / 1000) - 7 * 24 * 60 * 60
      expect(url.searchParams.get('start-date')).toBe(String(expected))
    } finally {
      await close()
    }
  })

  it('re-running the same night changes nothing, which is what makes a failed run survivable', async () => {
    const { db, close } = await makeTestDb()
    try {
      await putSecret(db, 'simplefin_access_url', ACCESS_URL)
      stubAccountsFetch()

      await runSyncJob(db, NOW)
      const second = await runSyncJob(db, NOW)

      // The counts are payload items *seen*, not rows written: the second run reports the
      // same two accounts having written nothing new. That is why they are not named
      // `accountsWritten`.
      expect(second).toEqual({ ok: true, accountsSeen: 2, transactionsSeen: 2 })
      expect(await db.select().from(accounts)).toHaveLength(2)
      expect(await db.select().from(transactions)).toHaveLength(2)
      expect(await db.select().from(balanceSnapshots)).toHaveLength(2)
      expect(await db.select().from(syncRuns)).toHaveLength(2)
    } finally {
      await close()
    }
  })

  it('records a failed fetch on the run row without leaking the access URL', async () => {
    const { db, close } = await makeTestDb()
    try {
      await putSecret(db, 'simplefin_access_url', ACCESS_URL)
      stubAccountsFetch({}, 403)

      const result = await runSyncJob(db, NOW)

      expect(result.ok).toBe(false)
      expect(serialize(result)).toMatch(/403/)
      expect(serialize(result)).not.toMatch(/s3cret|demo-user/)

      const [run] = await db.select().from(syncRuns)
      expect(run.status).toBe('error')
      expect(run.finishedAt).not.toBeNull()
      expect(run.error).toMatch(/403/)
      // The stored value must be a scrubbed string, never a serialized error object whose
      // `input` property carries the credentialed URL.
      expect(run.error).not.toMatch(/s3cret|demo-user/)
    } finally {
      await close()
    }
  })

  it('records a malformed payload as a failed run instead of writing corrupt data', async () => {
    const { db, close } = await makeTestDb()
    try {
      await putSecret(db, 'simplefin_access_url', ACCESS_URL)
      stubAccountsFetch({ accounts: [{ id: 'acct-broken', name: 'Broken', balance: 'abc' }] })

      const result = await runSyncJob(db, NOW)

      expect(result.ok).toBe(false)
      const [run] = await db.select().from(syncRuns)
      expect(run.status).toBe('error')
      expect(run.error).toMatch(/acct-broken/)
      expect(await db.select().from(accounts)).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('claims the setup token once, then never again — the token is single-use', async () => {
    const { db, close } = await makeTestDb()
    try {
      process.env.SIMPLEFIN_SETUP_TOKEN = SETUP_TOKEN
      const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) =>
        init?.method === 'POST'
          ? new Response(`${ACCESS_URL}\n`, { status: 200 })
          : new Response(JSON.stringify(fixture), { status: 200 }),
      )
      vi.stubGlobal('fetch', fetchMock)

      expect((await runSyncJob(db, NOW)).ok).toBe(true)
      expect(await getSecret(db, 'simplefin_access_url')).toBe(ACCESS_URL)

      const posts = () =>
        fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      expect(posts()).toHaveLength(1)

      expect((await runSyncJob(db, NOW)).ok).toBe(true)
      expect(posts()).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('fails the run when there is no stored access URL and no setup token', async () => {
    const { db, close } = await makeTestDb()
    try {
      const fetchMock = stubAccountsFetch()

      const result = await runSyncJob(db, NOW)

      expect(result.ok).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
      const [run] = await db.select().from(syncRuns)
      expect(run.status).toBe('error')
      expect(run.error).toMatch(/SIMPLEFIN_SETUP_TOKEN/)
    } finally {
      await close()
    }
  })

  it('never puts the setup token into the run row when the claim fails', async () => {
    const { db, close } = await makeTestDb()
    try {
      process.env.SIMPLEFIN_SETUP_TOKEN = SETUP_TOKEN
      stubAccountsFetch({}, 500)

      const result = await runSyncJob(db, NOW)

      expect(result.ok).toBe(false)
      const [run] = await db.select().from(syncRuns)
      expect(run.error).not.toMatch(/SETUP-TOKEN-SENTINEL/)
      expect(run.error).not.toContain(SETUP_TOKEN)
      expect(serialize(result)).not.toContain(SETUP_TOKEN)
      // A failed claim must not store a half-claimed secret.
      expect(await getSecret(db, 'simplefin_access_url')).toBeNull()
    } finally {
      await close()
    }
  })
})
