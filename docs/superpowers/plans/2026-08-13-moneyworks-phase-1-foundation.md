# MoneyWorks Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed, authenticated dashboard that syncs bank data nightly from SimpleFIN and shows accurate net worth with history, plus manual assets, debts, and goals.

**Architecture:** Next.js App Router on Vercel with Neon Postgres via Drizzle. A daily Vercel Cron job is the only writer of external financial data; it upserts accounts and transactions idempotently and appends one balance snapshot per account per day. Net worth is derived from those snapshots at query time, never stored. Server Components read Postgres directly — no financial records are fetched client-side.

**Tech Stack:** TypeScript, Next.js (App Router), Drizzle ORM, `@neondatabase/serverless`, Clerk, Vitest, PGlite (in-process Postgres for tests), Tailwind CSS, Recharts.

**Spec:** `docs/superpowers/specs/2026-08-13-moneyworks-design.md`

## Global Constraints

Every task's requirements implicitly include these.

- **Money is integer cents everywhere.** `bigint` in Postgres, `number` in TypeScript. Never a float, never a decimal string. Dollars appear only at the render boundary.
- **Rates are integer basis points.** 5.25% APR is `525`.
- **Liability balances are stored as a positive magnitude** of the amount owed, regardless of the sign the source reports. Net worth subtracts them.
- **Transaction `amount` keeps its natural sign.** Negative is money leaving the account.
- **USD only.** No currency column, no conversion.
- **The app connects through Neon's pooled endpoint** (the `-pooler` host). The direct endpoint is used only by the migration runner.
- **Read-only against all external financial data.** No code path writes to SimpleFIN or any bank.
- **Secrets are server-side only:** `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `ENCRYPTION_KEY`, `ALLOWED_EMAIL`, `CLERK_SECRET_KEY`. None may be referenced from a Client Component.
- **Sync runs daily at 09:00 UTC.** Snapshot dates are UTC dates.
- **Every task ends with a commit.**

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` | Drizzle table definitions — the single source of truth for shape |
| `src/db/client.ts` | Neon pooled connection, exported as `db` |
| `src/lib/money.ts` | Cents arithmetic and dollar formatting |
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt for at-rest secrets |
| `src/lib/secrets.ts` | Read/write encrypted values in the `secrets` table |
| `src/lib/net-worth.ts` | Derivation of net worth and its time series from snapshots |
| `src/sync/simplefin.ts` | SimpleFIN HTTP client and response normalization |
| `src/sync/run.ts` | Sync orchestration: upserts, snapshots, run bookkeeping |
| `src/app/api/sync/route.ts` | Cron entrypoint |
| `src/middleware.ts` | Clerk auth plus single-email allowlist |
| `src/app/(app)/page.tsx` | Dashboard |
| `src/app/(app)/assets/*` | Manual assets CRUD |
| `src/app/(app)/debts/*` | Debts and goals entry |
| `vercel.json` | Cron schedule |

Tests mirror source paths under `tests/`.

---

### Task 1: Project scaffold, schema, and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `drizzle.config.ts`, `.env.example`
- Create: `src/db/schema.ts`, `src/db/client.ts`
- Create: `tests/helpers/test-db.ts`, `tests/db/schema.test.ts`
- Create: `vitest.config.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `db` (Drizzle client), all table objects from `src/db/schema.ts`, and `makeTestDb(): Promise<TestDb>` where `TestDb = { db: DrizzleDb; close: () => Promise<void> }`

- [ ] **Step 1: Initialize the project and install dependencies**

```bash
npx create-next-app@latest . --typescript --tailwind --app --src-dir --no-eslint --use-npm
npm install drizzle-orm @neondatabase/serverless
npm install -D drizzle-kit vitest @electric-sql/pglite dotenv
```

- [ ] **Step 2: Write the schema**

The spec's data model also lists `briefings` and `insights`. Those are **deliberately omitted here** — they belong to Phase 3 and creating them now would ship empty tables no code reads. This is not an oversight.

Create `src/db/schema.ts`:

```typescript
import {
  pgTable, uuid, text, boolean, date, bigint, integer, timestamp, primaryKey, customType,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  simplefinId: text('simplefin_id').unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  isAsset: boolean('is_asset').notNull(),
  manual: boolean('manual').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const balanceSnapshots = pgTable('balance_snapshots', {
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  date: date('date').notNull(),
  balance: bigint('balance', { mode: 'number' }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.accountId, t.date] }) }))

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  simplefinId: text('simplefin_id').unique(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  date: date('date').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  description: text('description').notNull(),
  merchant: text('merchant'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const manualAssets = pgTable('manual_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  isAsset: boolean('is_asset').notNull(),
  value: bigint('value', { mode: 'number' }).notNull(),
  asOf: date('as_of').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const debts = pgTable('debts', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id),
  aprBps: integer('apr_bps').notNull(),
  minimumPayment: bigint('minimum_payment', { mode: 'number' }).notNull(),
  targetPayoff: date('target_payoff'),
})

export const goals = pgTable('goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  targetAmount: bigint('target_amount', { mode: 'number' }).notNull(),
  targetDate: date('target_date'),
  linkedAccountId: uuid('linked_account_id').references(() => accounts.id),
})

export const syncRuns = pgTable('sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull(),
  error: text('error'),
})

export const secrets = pgTable('secrets', {
  key: text('key').primaryKey(),
  ciphertext: bytea('ciphertext').notNull(),
  iv: bytea('iv').notNull(),
  authTag: bytea('auth_tag').notNull(),
})
```

- [ ] **Step 3: Write the Neon client and Drizzle config**

Create `src/db/client.ts`:

```typescript
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

// DATABASE_URL must be the POOLED (-pooler) Neon endpoint.
const sql = neon(process.env.DATABASE_URL!)
export const db = drizzle(sql, { schema })
```

Create `drizzle.config.ts`:

```typescript
import type { Config } from 'drizzle-kit'

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Migrations run against the DIRECT (unpooled) endpoint.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED! },
} satisfies Config
```

Create `.env.example`:

```
DATABASE_URL=postgresql://...-pooler.neon.tech/moneyworks
DATABASE_URL_UNPOOLED=postgresql://...neon.tech/moneyworks
ENCRYPTION_KEY=
ALLOWED_EMAIL=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
```

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new SQL file under `drizzle/` containing `CREATE TABLE` for all eight tables.

- [ ] **Step 5: Write the test harness**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: { environment: 'node' },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
})
```

Create `tests/helpers/test-db.ts`:

```typescript
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as schema from '@/db/schema'

export async function makeTestDb() {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: './drizzle' })
  return { db, close: () => client.close() }
}

export type TestDb = Awaited<ReturnType<typeof makeTestDb>>['db']
```

- [ ] **Step 6: Write the failing test**

Create `tests/db/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { accounts, balanceSnapshots } from '@/db/schema'

describe('schema', () => {
  it('round-trips an account and a balance snapshot in integer cents', async () => {
    const { db, close } = await makeTestDb()
    const [acct] = await db.insert(accounts)
      .values({ name: 'Checking', type: 'checking', isAsset: true })
      .returning()

    await db.insert(balanceSnapshots)
      .values({ accountId: acct.id, date: '2026-08-13', balance: 123456 })

    const rows = await db.select().from(balanceSnapshots)
    expect(rows).toHaveLength(1)
    expect(rows[0].balance).toBe(123456)
    expect(typeof rows[0].balance).toBe('number')
    await close()
  })
})
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: FAIL — the `drizzle/` migrations folder is empty or the alias is unresolved, depending on order.

- [ ] **Step 8: Add the test script and make it pass**

Add to `package.json` scripts: `"test": "vitest run"`, `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"`.

Run: `npx vitest run tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: project scaffold, Drizzle schema, and PGlite test harness"
```

---

### Task 2: Money helpers

**Files:**
- Create: `src/lib/money.ts`
- Test: `tests/lib/money.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `dollarsToCents(dollars: number): number`, `centsToDollars(cents: number): number`, `formatCents(cents: number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/money.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { dollarsToCents, centsToDollars, formatCents } from '@/lib/money'

describe('money', () => {
  it('converts dollars to cents without float drift', () => {
    expect(dollarsToCents(19.99)).toBe(1999)
    expect(dollarsToCents(0.1 + 0.2)).toBe(30)
    expect(dollarsToCents(-45.5)).toBe(-4550)
  })

  it('converts cents back to dollars', () => {
    expect(centsToDollars(1999)).toBe(19.99)
  })

  it('formats cents as USD', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(-4550)).toBe('-$45.50')
    expect(formatCents(0)).toBe('$0.00')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/money.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/money'"

- [ ] **Step 3: Write the implementation**

Create `src/lib/money.ts`:

```typescript
/** All money in this app is integer cents. These are the only conversion points. */

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100)
}

export function centsToDollars(cents: number): number {
  return cents / 100
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function formatCents(cents: number): string {
  return USD.format(centsToDollars(cents))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/money.test.ts`
Expected: PASS. If `formatCents(-4550)` returns `-$45.50` vs `($45.50)`, keep the implementation and update the test to match `Intl` output for the runtime's ICU build.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts tests/lib/money.test.ts
git commit -m "feat: integer-cents money helpers"
```

---

### Task 3: Encryption and the secrets store

**Files:**
- Create: `src/lib/crypto.ts`, `src/lib/secrets.ts`
- Test: `tests/lib/crypto.test.ts`, `tests/lib/secrets.test.ts`

**Interfaces:**
- Consumes: `db` and `secrets` table from Task 1
- Produces:
  - `encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer }`
  - `decrypt(parts: { ciphertext: Buffer; iv: Buffer; authTag: Buffer }): string`
  - `putSecret(db: DrizzleDb, key: string, value: string): Promise<void>`
  - `getSecret(db: DrizzleDb, key: string): Promise<string | null>`

- [ ] **Step 1: Write the failing crypto test**

Create `tests/lib/crypto.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encrypt, decrypt } from '@/lib/crypto'

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

describe('crypto', () => {
  it('round-trips a secret', () => {
    const parts = encrypt('https://user:pass@bridge.simplefin.org/accounts')
    expect(decrypt(parts)).toBe('https://user:pass@bridge.simplefin.org/accounts')
  })

  it('produces a distinct IV per call', () => {
    expect(encrypt('same').iv.equals(encrypt('same').iv)).toBe(false)
  })

  it('rejects tampered ciphertext', () => {
    const parts = encrypt('secret')
    parts.ciphertext[0] ^= 0xff
    expect(() => decrypt(parts)).toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/crypto.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/crypto'"

- [ ] **Step 3: Write the crypto implementation**

Create `src/lib/crypto.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY is not set')
  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded')
  return buf
}

export function encrypt(plaintext: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext, iv, authTag: cipher.getAuthTag() }
}

export function decrypt(parts: { ciphertext: Buffer; iv: Buffer; authTag: Buffer }): string {
  const decipher = createDecipheriv(ALGO, key(), parts.iv)
  decipher.setAuthTag(parts.authTag)
  return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run the crypto test to verify it passes**

Run: `npx vitest run tests/lib/crypto.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing secrets-store test**

Create `tests/lib/secrets.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { makeTestDb } from '../helpers/test-db'
import { putSecret, getSecret } from '@/lib/secrets'
import { secrets } from '@/db/schema'

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

describe('secrets store', () => {
  it('stores a value encrypted and reads it back', async () => {
    const { db, close } = await makeTestDb()
    await putSecret(db, 'simplefin_access_url', 'https://example.test/accounts')

    const raw = await db.select().from(secrets)
    expect(raw[0].ciphertext.toString('utf8')).not.toContain('example.test')

    expect(await getSecret(db, 'simplefin_access_url')).toBe('https://example.test/accounts')
    await close()
  })

  it('overwrites an existing key', async () => {
    const { db, close } = await makeTestDb()
    await putSecret(db, 'k', 'first')
    await putSecret(db, 'k', 'second')
    expect(await getSecret(db, 'k')).toBe('second')
    await close()
  })

  it('returns null for a missing key', async () => {
    const { db, close } = await makeTestDb()
    expect(await getSecret(db, 'nope')).toBeNull()
    await close()
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/lib/secrets.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/secrets'"

- [ ] **Step 7: Write the secrets store**

Create `src/lib/secrets.ts`:

```typescript
import { eq } from 'drizzle-orm'
import { secrets } from '@/db/schema'
import { encrypt, decrypt } from './crypto'

export async function putSecret(db: any, key: string, value: string): Promise<void> {
  const { ciphertext, iv, authTag } = encrypt(value)
  await db.insert(secrets)
    .values({ key, ciphertext, iv, authTag })
    .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, iv, authTag } })
}

export async function getSecret(db: any, key: string): Promise<string | null> {
  const rows = await db.select().from(secrets).where(eq(secrets.key, key))
  if (rows.length === 0) return null
  const r = rows[0]
  return decrypt({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.authTag })
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/lib/secrets.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/lib/crypto.ts src/lib/secrets.ts tests/lib/crypto.test.ts tests/lib/secrets.test.ts
git commit -m "feat: AES-256-GCM encryption and encrypted secrets store"
```

---

### Task 4: Net worth derivation

This is the core of the product. Everything else is plumbing around it.

**Files:**
- Create: `src/lib/net-worth.ts`
- Test: `tests/lib/net-worth.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions over plain inputs)
- Produces:
  - `type AccountBalance = { accountId: string; isAsset: boolean; date: string; balance: number }`
  - `type ManualAssetValue = { name: string; isAsset: boolean; asOf: string; value: number }` — identity across revaluations is `name`, **not** the row id, because Task 10 appends a new row per revaluation
  - `netWorthOn(date: string, snapshots: AccountBalance[], manual: ManualAssetValue[]): number`
  - `netWorthSeries(dates: string[], snapshots: AccountBalance[], manual: ManualAssetValue[]): { date: string; netWorth: number }[]`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/net-worth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { netWorthOn, netWorthSeries } from '@/lib/net-worth'
import type { AccountBalance, ManualAssetValue } from '@/lib/net-worth'

const snap = (accountId: string, isAsset: boolean, date: string, balance: number): AccountBalance =>
  ({ accountId, isAsset, date, balance })

describe('netWorthOn', () => {
  it('subtracts liabilities, which are stored as positive magnitudes', () => {
    const snaps = [
      snap('checking', true, '2026-08-01', 500_00),
      snap('visa', false, '2026-08-01', 200_00),
    ]
    expect(netWorthOn('2026-08-01', snaps, [])).toBe(300_00)
  })

  it('carries forward the most recent snapshot on or before the date', () => {
    const snaps = [
      snap('checking', true, '2026-08-01', 500_00),
      snap('checking', true, '2026-08-05', 700_00),
    ]
    expect(netWorthOn('2026-08-03', snaps, [])).toBe(500_00)
    expect(netWorthOn('2026-08-05', snaps, [])).toBe(700_00)
    expect(netWorthOn('2026-08-09', snaps, [])).toBe(700_00)
  })

  it('treats an account with no snapshot yet as zero rather than erroring', () => {
    const snaps = [snap('checking', true, '2026-08-05', 700_00)]
    expect(netWorthOn('2026-08-01', snaps, [])).toBe(0)
  })

  it('counts only the most recent valuation of a revalued asset', () => {
    // Two rows for the same house — a revaluation, not two houses.
    const manual: ManualAssetValue[] = [
      { name: 'House', isAsset: true, asOf: '2026-01-01', value: 400_000_00 },
      { name: 'House', isAsset: true, asOf: '2026-07-01', value: 420_000_00 },
      { name: 'Mortgage', isAsset: false, asOf: '2026-07-01', value: 250_000_00 },
    ]
    expect(netWorthOn('2026-03-01', [], manual)).toBe(400_000_00)
    expect(netWorthOn('2026-08-01', [], manual)).toBe(170_000_00)
  })

  it('returns zero when there is no data at all', () => {
    expect(netWorthOn('2026-08-01', [], [])).toBe(0)
  })
})

describe('netWorthSeries', () => {
  it('produces one point per requested date', () => {
    const snaps = [
      snap('checking', true, '2026-08-01', 100_00),
      snap('checking', true, '2026-08-03', 300_00),
    ]
    expect(netWorthSeries(['2026-08-01', '2026-08-02', '2026-08-03'], snaps, [])).toEqual([
      { date: '2026-08-01', netWorth: 100_00 },
      { date: '2026-08-02', netWorth: 100_00 },
      { date: '2026-08-03', netWorth: 300_00 },
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/net-worth.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/net-worth'"

- [ ] **Step 3: Write the implementation**

Create `src/lib/net-worth.ts`:

```typescript
export type AccountBalance = {
  accountId: string
  isAsset: boolean
  date: string // ISO yyyy-mm-dd
  balance: number // integer cents, positive magnitude
}

export type ManualAssetValue = {
  /** Identity across revaluations. Revaluing appends a row with a new id but the same name. */
  name: string
  isAsset: boolean
  asOf: string // ISO yyyy-mm-dd
  value: number // integer cents, positive magnitude
}

/** Latest entry per key whose date is on or before `date`. */
function latestOnOrBefore<T extends { date: string }>(
  rows: T[],
  date: string,
  keyOf: (row: T) => string,
): T[] {
  const best = new Map<string, T>()
  for (const row of rows) {
    if (row.date > date) continue
    const k = keyOf(row)
    const current = best.get(k)
    if (!current || row.date > current.date) best.set(k, row)
  }
  return [...best.values()]
}

export function netWorthOn(
  date: string,
  snapshots: AccountBalance[],
  manual: ManualAssetValue[],
): number {
  const accountRows = latestOnOrBefore(snapshots, date, (r) => r.accountId)
  const manualRows = latestOnOrBefore(
    manual.map((m) => ({ ...m, date: m.asOf })),
    date,
    (r) => r.name,
  )

  let total = 0
  for (const r of accountRows) total += r.isAsset ? r.balance : -r.balance
  for (const r of manualRows) total += r.isAsset ? r.value : -r.value
  return total
}

export function netWorthSeries(
  dates: string[],
  snapshots: AccountBalance[],
  manual: ManualAssetValue[],
): { date: string; netWorth: number }[] {
  return dates.map((date) => ({ date, netWorth: netWorthOn(date, snapshots, manual) }))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/net-worth.test.ts`
Expected: PASS — all 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/net-worth.ts tests/lib/net-worth.test.ts
git commit -m "feat: derive net worth and its time series from balance snapshots"
```

---

### Task 5: SimpleFIN client and normalization

**Files:**
- Create: `src/sync/simplefin.ts`
- Test: `tests/sync/simplefin.test.ts`, `tests/fixtures/simplefin-accounts.json`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type NormalizedAccount = { simplefinId: string; name: string; type: string; isAsset: boolean; balance: number }`
  - `type NormalizedTransaction = { simplefinId: string; simplefinAccountId: string; date: string; amount: number; description: string }`
  - `normalizeAccountsResponse(json: unknown): { accounts: NormalizedAccount[]; transactions: NormalizedTransaction[] }`
  - `claimAccessUrl(setupToken: string): Promise<string>`
  - `fetchAccounts(accessUrl: string, sinceEpochSeconds: number): Promise<unknown>`

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/simplefin-accounts.json`:

```json
{
  "accounts": [
    {
      "id": "acct-checking",
      "name": "Everyday Checking",
      "currency": "USD",
      "balance": "1543.27",
      "transactions": [
        { "id": "txn-1", "posted": 1786000000, "amount": "-45.50", "description": "COFFEE ROASTERS" }
      ]
    },
    {
      "id": "acct-visa",
      "name": "Visa Signature",
      "currency": "USD",
      "balance": "-892.10",
      "transactions": [
        { "id": "txn-2", "posted": 1786100000, "amount": "-120.00", "description": "HARDWARE STORE" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/sync/simplefin.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { normalizeAccountsResponse } from '@/sync/simplefin'
import fixture from '../fixtures/simplefin-accounts.json'

describe('normalizeAccountsResponse', () => {
  const { accounts, transactions } = normalizeAccountsResponse(fixture)

  it('converts balances to integer cents', () => {
    expect(accounts.find((a) => a.simplefinId === 'acct-checking')!.balance).toBe(154327)
  })

  it('classifies a negative balance as a liability and stores a positive magnitude', () => {
    const visa = accounts.find((a) => a.simplefinId === 'acct-visa')!
    expect(visa.isAsset).toBe(false)
    expect(visa.balance).toBe(89210)
  })

  it('keeps the natural sign on transaction amounts', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-1')!.amount).toBe(-4550)
  })

  it('converts posted epoch seconds to an ISO date', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-1')!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('links each transaction to its account', () => {
    expect(transactions.find((t) => t.simplefinId === 'txn-2')!.simplefinAccountId).toBe('acct-visa')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/sync/simplefin.test.ts`
Expected: FAIL — "Failed to resolve import '@/sync/simplefin'"

- [ ] **Step 4: Write the implementation**

Create `src/sync/simplefin.ts`:

```typescript
import { dollarsToCents } from '@/lib/money'

export type NormalizedAccount = {
  simplefinId: string
  name: string
  type: string
  isAsset: boolean
  balance: number // positive magnitude, integer cents
}

export type NormalizedTransaction = {
  simplefinId: string
  simplefinAccountId: string
  date: string
  amount: number // signed, integer cents
  description: string
}

function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

export function normalizeAccountsResponse(json: unknown): {
  accounts: NormalizedAccount[]
  transactions: NormalizedTransaction[]
} {
  const raw = json as { accounts?: any[] }
  const accounts: NormalizedAccount[] = []
  const transactions: NormalizedTransaction[] = []

  for (const a of raw.accounts ?? []) {
    const signed = dollarsToCents(Number(a.balance))
    // SimpleFIN reports what you owe as a negative balance. We store liabilities
    // as a positive magnitude and let net worth do the subtracting.
    const isAsset = signed >= 0
    accounts.push({
      simplefinId: a.id,
      name: a.name,
      type: isAsset ? 'asset' : 'liability',
      isAsset,
      balance: Math.abs(signed),
    })

    for (const t of a.transactions ?? []) {
      transactions.push({
        simplefinId: t.id,
        simplefinAccountId: a.id,
        date: isoDate(t.posted),
        amount: dollarsToCents(Number(t.amount)),
        description: t.description ?? '',
      })
    }
  }

  return { accounts, transactions }
}

/** One-time exchange of a setup token for a permanent access URL. */
export async function claimAccessUrl(setupToken: string): Promise<string> {
  const claimUrl = Buffer.from(setupToken, 'base64').toString('utf8')
  const res = await fetch(claimUrl, { method: 'POST' })
  if (!res.ok) throw new Error(`SimpleFIN claim failed: ${res.status}`)
  return (await res.text()).trim()
}

export async function fetchAccounts(accessUrl: string, sinceEpochSeconds: number): Promise<unknown> {
  const url = new URL(`${accessUrl}/accounts`)
  url.searchParams.set('start-date', String(sinceEpochSeconds))
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`SimpleFIN fetch failed: ${res.status}`)
  return res.json()
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/sync/simplefin.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 6: Commit**

```bash
git add src/sync/simplefin.ts tests/sync/simplefin.test.ts tests/fixtures/simplefin-accounts.json
git commit -m "feat: SimpleFIN client with balance and transaction normalization"
```

---

### Task 6: The sync job

**Files:**
- Create: `src/sync/run.ts`
- Test: `tests/sync/run.test.ts`

**Interfaces:**
- Consumes: `normalizeAccountsResponse` (Task 5), schema tables (Task 1)
- Produces: `applySync(db, payload: unknown, today: string): Promise<{ accounts: number; transactions: number }>`

`applySync` takes an already-fetched payload and an explicit date so it is deterministic and testable without network or clock access. The route handler in Task 8 supplies both.

- [ ] **Step 1: Write the failing test**

Create `tests/sync/run.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { applySync } from '@/sync/run'
import { accounts, balanceSnapshots, transactions } from '@/db/schema'
import fixture from '../fixtures/simplefin-accounts.json'

describe('applySync', () => {
  it('inserts accounts, transactions, and one snapshot per account', async () => {
    const { db, close } = await makeTestDb()
    await applySync(db, fixture, '2026-08-13')

    expect(await db.select().from(accounts)).toHaveLength(2)
    expect(await db.select().from(transactions)).toHaveLength(2)
    expect(await db.select().from(balanceSnapshots)).toHaveLength(2)
    await close()
  })

  it('is idempotent: running the same payload twice creates no duplicates', async () => {
    const { db, close } = await makeTestDb()
    await applySync(db, fixture, '2026-08-13')
    await applySync(db, fixture, '2026-08-13')

    expect(await db.select().from(accounts)).toHaveLength(2)
    expect(await db.select().from(transactions)).toHaveLength(2)
    expect(await db.select().from(balanceSnapshots)).toHaveLength(2)
    await close()
  })

  it('writes a new snapshot row on a new date, keeping the old one', async () => {
    const { db, close } = await makeTestDb()
    await applySync(db, fixture, '2026-08-13')
    await applySync(db, fixture, '2026-08-14')

    expect(await db.select().from(balanceSnapshots)).toHaveLength(4)
    await close()
  })

  it('updates a snapshot in place when the balance changes on the same date', async () => {
    const { db, close } = await makeTestDb()
    await applySync(db, fixture, '2026-08-13')

    const revised = structuredClone(fixture)
    revised.accounts[0].balance = '2000.00'
    await applySync(db, revised, '2026-08-13')

    const rows = await db.select().from(balanceSnapshots)
    expect(rows).toHaveLength(2)
    expect(rows.some((r) => r.balance === 200000)).toBe(true)
    await close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/sync/run.test.ts`
Expected: FAIL — "Failed to resolve import '@/sync/run'"

- [ ] **Step 3: Write the implementation**

Create `src/sync/run.ts`:

```typescript
import { eq } from 'drizzle-orm'
import { accounts, balanceSnapshots, transactions } from '@/db/schema'
import { normalizeAccountsResponse } from './simplefin'

export async function applySync(db: any, payload: unknown, today: string) {
  const normalized = normalizeAccountsResponse(payload)
  const idByExternal = new Map<string, string>()

  for (const a of normalized.accounts) {
    const [row] = await db.insert(accounts)
      .values({
        simplefinId: a.simplefinId,
        name: a.name,
        type: a.type,
        isAsset: a.isAsset,
        manual: false,
      })
      .onConflictDoUpdate({
        target: accounts.simplefinId,
        set: { name: a.name, type: a.type, isAsset: a.isAsset },
      })
      .returning()
    idByExternal.set(a.simplefinId, row.id)

    await db.insert(balanceSnapshots)
      .values({ accountId: row.id, date: today, balance: a.balance })
      .onConflictDoUpdate({
        target: [balanceSnapshots.accountId, balanceSnapshots.date],
        set: { balance: a.balance },
      })
  }

  for (const t of normalized.transactions) {
    const accountId = idByExternal.get(t.simplefinAccountId)
    if (!accountId) continue
    await db.insert(transactions)
      .values({
        simplefinId: t.simplefinId,
        accountId,
        date: t.date,
        amount: t.amount,
        description: t.description,
      })
      .onConflictDoNothing({ target: transactions.simplefinId })
  }

  return { accounts: normalized.accounts.length, transactions: normalized.transactions.length }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/sync/run.test.ts`
Expected: PASS — all 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/sync/run.ts tests/sync/run.test.ts
git commit -m "feat: idempotent sync that upserts accounts, transactions, and daily snapshots"
```

---

### Task 7: Auth and the single-user allowlist

**Files:**
- Create: `src/middleware.ts`, `src/lib/auth.ts`
- Test: `tests/lib/auth.test.ts`
- Modify: `src/app/layout.tsx` (wrap in `ClerkProvider`)

**Interfaces:**
- Consumes: nothing
- Produces: `isAllowedEmail(email: string | null | undefined): boolean`

- [ ] **Step 1: Install Clerk**

```bash
npm install @clerk/nextjs
```

- [ ] **Step 2: Write the failing test**

Create `tests/lib/auth.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { isAllowedEmail } from '@/lib/auth'

beforeEach(() => {
  process.env.ALLOWED_EMAIL = 'Owner@Example.com'
})

describe('isAllowedEmail', () => {
  it('accepts the allowlisted address', () => {
    expect(isAllowedEmail('owner@example.com')).toBe(true)
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(isAllowedEmail('  OWNER@EXAMPLE.COM ')).toBe(true)
  })

  it('rejects any other address', () => {
    expect(isAllowedEmail('someone@else.com')).toBe(false)
  })

  it('rejects null and undefined', () => {
    expect(isAllowedEmail(null)).toBe(false)
    expect(isAllowedEmail(undefined)).toBe(false)
  })

  it('fails closed when ALLOWED_EMAIL is unset', () => {
    delete process.env.ALLOWED_EMAIL
    expect(isAllowedEmail('owner@example.com')).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/lib/auth.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/auth'"

- [ ] **Step 4: Write the implementation**

Create `src/lib/auth.ts`:

```typescript
export function isAllowedEmail(email: string | null | undefined): boolean {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  if (!allowed) return false // fail closed
  if (!email) return false
  return email.trim().toLowerCase() === allowed
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/lib/auth.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 6: Wire the middleware**

Create `src/middleware.ts`:

```typescript
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { isAllowedEmail } from '@/lib/auth'

// The cron route authenticates with a shared secret, not a Clerk session.
const isPublic = createRouteMatcher(['/api/sync', '/sign-in(.*)', '/sign-up(.*)'])

export default clerkMiddleware(async (auth, req) => {
  if (isPublic(req)) return

  const { userId, sessionClaims } = await auth()
  if (!userId) return (await auth()).redirectToSignIn()

  const email = (sessionClaims as { email?: string } | null)?.email
  if (!isAllowedEmail(email)) {
    return new NextResponse('Forbidden', { status: 403 })
  }
})

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)', '/api/(.*)'],
}
```

Wrap the root layout's children in `<ClerkProvider>` in `src/app/layout.tsx`.

In the Clerk dashboard, add `email` to the session token claims so `sessionClaims.email` is populated.

- [ ] **Step 7: Verify manually**

Run `npm run dev`, sign in with a non-allowlisted address, and confirm a 403. Sign in with `ALLOWED_EMAIL` and confirm the dashboard loads.

- [ ] **Step 8: Commit**

```bash
git add src/middleware.ts src/lib/auth.ts src/app/layout.tsx tests/lib/auth.test.ts package.json package-lock.json
git commit -m "feat: Clerk auth with single-user email allowlist"
```

---

### Task 8: Sync route and cron schedule

**Files:**
- Create: `src/app/api/sync/route.ts`, `vercel.json`
- Modify: `.env.example` (add `CRON_SECRET`, `SIMPLEFIN_SETUP_TOKEN`)

**Interfaces:**
- Consumes: `applySync` (Task 6), `fetchAccounts`/`claimAccessUrl` (Task 5), `getSecret`/`putSecret` (Task 3)
- Produces: `POST /api/sync`

- [ ] **Step 1: Write the route**

Create `src/app/api/sync/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { syncRuns } from '@/db/schema'
import { getSecret, putSecret } from '@/lib/secrets'
import { claimAccessUrl, fetchAccounts } from '@/sync/simplefin'
import { applySync } from '@/sync/run'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const [run] = await db.insert(syncRuns).values({ status: 'running' }).returning()

  try {
    let accessUrl = await getSecret(db, 'simplefin_access_url')
    if (!accessUrl) {
      const token = process.env.SIMPLEFIN_SETUP_TOKEN
      if (!token) throw new Error('No access URL stored and SIMPLEFIN_SETUP_TOKEN is unset')
      accessUrl = await claimAccessUrl(token)
      await putSecret(db, 'simplefin_access_url', accessUrl)
    }

    // 7-day overlap: institutions revise recently posted transactions.
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
    const payload = await fetchAccounts(accessUrl, since)
    const today = new Date().toISOString().slice(0, 10)
    const counts = await applySync(db, payload, today)

    await db.update(syncRuns)
      .set({ status: 'ok', finishedAt: new Date() })
      .where(eq(syncRuns.id, run.id))

    return NextResponse.json({ ok: true, ...counts })
  } catch (err) {
    await db.update(syncRuns)
      .set({ status: 'error', error: String(err), finishedAt: new Date() })
      .where(eq(syncRuns.id, run.id))
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
```

- [ ] **Step 2: Add the cron schedule**

Create `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/sync", "schedule": "0 9 * * *" }
  ]
}
```

- [ ] **Step 3: Verify manually against the real SimpleFIN account**

Set `SIMPLEFIN_SETUP_TOKEN` and `CRON_SECRET` locally, then:

```bash
curl -X POST localhost:3000/api/sync -H "Authorization: Bearer $CRON_SECRET"
```

Expected: `{"ok":true,"accounts":N,"transactions":M}` and a `sync_runs` row with status `ok`. Run it a second time and confirm the counts are unchanged in the database.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sync/route.ts vercel.json .env.example
git commit -m "feat: sync route with cron schedule and run bookkeeping"
```

---

### Task 9: Dashboard

**Files:**
- Create: `src/lib/queries.ts`, `src/app/(app)/page.tsx`, `src/components/net-worth-chart.tsx`, `src/components/staleness-banner.tsx`
- Test: `tests/lib/queries.test.ts`

**Interfaces:**
- Consumes: `netWorthOn`/`netWorthSeries` (Task 4), `formatCents` (Task 2), schema (Task 1)
- Produces:
  - `loadNetWorthInputs(db): Promise<{ snapshots: AccountBalance[]; manual: ManualAssetValue[] }>`
  - `lastSuccessfulSync(db): Promise<Date | null>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/queries.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { loadNetWorthInputs, lastSuccessfulSync } from '@/lib/queries'
import { accounts, balanceSnapshots, manualAssets, syncRuns } from '@/db/schema'

describe('queries', () => {
  it('loads snapshots joined to their account asset flag', async () => {
    const { db, close } = await makeTestDb()
    const [a] = await db.insert(accounts)
      .values({ name: 'Visa', type: 'liability', isAsset: false }).returning()
    await db.insert(balanceSnapshots)
      .values({ accountId: a.id, date: '2026-08-13', balance: 50000 })
    await db.insert(manualAssets)
      .values({ name: 'House', kind: 'property', isAsset: true, value: 40000000, asOf: '2026-01-01' })

    const { snapshots, manual } = await loadNetWorthInputs(db)
    expect(snapshots[0]).toMatchObject({ isAsset: false, balance: 50000, date: '2026-08-13' })
    expect(manual[0]).toMatchObject({ name: 'House', isAsset: true, value: 40000000, asOf: '2026-01-01' })
    await close()
  })

  it('returns the most recent successful sync time, ignoring failures', async () => {
    const { db, close } = await makeTestDb()
    await db.insert(syncRuns).values({ status: 'ok', finishedAt: new Date('2026-08-10T09:00:00Z') })
    await db.insert(syncRuns).values({ status: 'error', finishedAt: new Date('2026-08-13T09:00:00Z') })

    const at = await lastSuccessfulSync(db)
    expect(at?.toISOString()).toBe('2026-08-10T09:00:00.000Z')
    await close()
  })

  it('returns null when no sync has ever succeeded', async () => {
    const { db, close } = await makeTestDb()
    expect(await lastSuccessfulSync(db)).toBeNull()
    await close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/queries.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/queries'"

- [ ] **Step 3: Write the queries**

Create `src/lib/queries.ts`:

```typescript
import { eq, desc, and, isNotNull } from 'drizzle-orm'
import { accounts, balanceSnapshots, manualAssets, syncRuns } from '@/db/schema'
import type { AccountBalance, ManualAssetValue } from './net-worth'

export async function loadNetWorthInputs(db: any): Promise<{
  snapshots: AccountBalance[]
  manual: ManualAssetValue[]
}> {
  const snapRows = await db.select({
    accountId: balanceSnapshots.accountId,
    date: balanceSnapshots.date,
    balance: balanceSnapshots.balance,
    isAsset: accounts.isAsset,
  })
    .from(balanceSnapshots)
    .innerJoin(accounts, eq(balanceSnapshots.accountId, accounts.id))

  const manualRows = await db.select().from(manualAssets)

  return {
    snapshots: snapRows,
    // Keyed by name, not id: revaluation appends a new row with a new id.
    manual: manualRows.map((m: any) => ({
      name: m.name, isAsset: m.isAsset, asOf: m.asOf, value: m.value,
    })),
  }
}

export async function lastSuccessfulSync(db: any): Promise<Date | null> {
  const rows = await db.select().from(syncRuns)
    .where(and(eq(syncRuns.status, 'ok'), isNotNull(syncRuns.finishedAt)))
    .orderBy(desc(syncRuns.finishedAt))
    .limit(1)
  return rows[0]?.finishedAt ?? null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/queries.test.ts`
Expected: PASS — all 3 tests

- [ ] **Step 5: Build the dashboard page**

```bash
npm install recharts
```

Create `src/app/(app)/page.tsx`:

```tsx
import { db } from '@/db/client'
import { loadNetWorthInputs, lastSuccessfulSync } from '@/lib/queries'
import { netWorthOn, netWorthSeries } from '@/lib/net-worth'
import { formatCents } from '@/lib/money'
import { NetWorthChart } from '@/components/net-worth-chart'
import { StalenessBanner } from '@/components/staleness-banner'

function lastNDates(n: number): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

export default async function DashboardPage() {
  const { snapshots, manual } = await loadNetWorthInputs(db)
  const syncedAt = await lastSuccessfulSync(db)
  const today = new Date().toISOString().slice(0, 10)

  const current = netWorthOn(today, snapshots, manual)
  const series = netWorthSeries(lastNDates(90), snapshots, manual)

  return (
    <main className="mx-auto max-w-4xl p-8 space-y-8">
      <StalenessBanner syncedAt={syncedAt} />
      <section>
        <h1 className="text-sm uppercase tracking-wide text-neutral-500">Net worth</h1>
        <p className="text-5xl font-semibold tabular-nums">{formatCents(current)}</p>
      </section>
      <NetWorthChart data={series} />
    </main>
  )
}
```

Create `src/components/net-worth-chart.tsx`:

```tsx
'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { formatCents } from '@/lib/money'

export function NetWorthChart({ data }: { data: { date: string; netWorth: number }[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <LineChart data={data}>
          <XAxis dataKey="date" tick={{ fontSize: 12 }} minTickGap={40} />
          <YAxis tickFormatter={(v) => formatCents(v)} width={90} tick={{ fontSize: 12 }} />
          <Tooltip formatter={(v: number) => formatCents(v)} />
          <Line type="monotone" dataKey="netWorth" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

Create `src/components/staleness-banner.tsx`:

```tsx
export function StalenessBanner({ syncedAt }: { syncedAt: Date | null }) {
  if (!syncedAt) {
    return <p className="rounded bg-amber-100 p-3 text-sm">No successful sync yet.</p>
  }
  const days = Math.floor((Date.now() - syncedAt.getTime()) / 86_400_000)
  if (days < 2) return null
  return (
    <p className="rounded bg-amber-100 p-3 text-sm">
      Last synced {days} days ago — balances may be out of date.
    </p>
  )
}
```

- [ ] **Step 6: Verify manually**

Run `npm run dev`, sign in as the allowlisted user, and confirm the net worth figure matches a hand-computed sum of your synced balances minus liabilities.

- [ ] **Step 7: Commit**

```bash
git add src/lib/queries.ts src/app/\(app\)/page.tsx src/components tests/lib/queries.test.ts package.json package-lock.json
git commit -m "feat: dashboard with net worth, 90-day chart, and staleness banner"
```

---

### Task 10: Manual assets

**Files:**
- Create: `src/app/(app)/assets/page.tsx`, `src/app/(app)/assets/actions.ts`
- Test: `tests/app/assets-actions.test.ts`

**Interfaces:**
- Consumes: schema (Task 1), `dollarsToCents` (Task 2)
- Produces: `addManualAsset(db, input: { name: string; kind: string; isAsset: boolean; valueDollars: number; asOf: string }): Promise<void>`, `revalueManualAsset(db, input: { name: string; valueDollars: number; asOf: string }): Promise<void>`

Revaluing appends a **new row** carrying the same identity fields rather than updating in place, so history is preserved. Identity across revaluations is the asset `name`.

- [ ] **Step 1: Write the failing test**

Create `tests/app/assets-actions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { addManualAsset, revalueManualAsset } from '@/app/(app)/assets/actions'
import { manualAssets } from '@/db/schema'

describe('manual assets', () => {
  it('stores a dollar input as integer cents', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, {
      name: 'House', kind: 'property', isAsset: true, valueDollars: 420000, asOf: '2026-01-01',
    })
    const rows = await db.select().from(manualAssets)
    expect(rows[0].value).toBe(42000000)
    await close()
  })

  it('appends a row on revaluation instead of overwriting history', async () => {
    const { db, close } = await makeTestDb()
    await addManualAsset(db, {
      name: 'House', kind: 'property', isAsset: true, valueDollars: 400000, asOf: '2026-01-01',
    })
    await revalueManualAsset(db, { name: 'House', valueDollars: 420000, asOf: '2026-07-01' })

    const rows = await db.select().from(manualAssets)
    expect(rows).toHaveLength(2)
    expect(rows.map((r: any) => r.value).sort()).toEqual([40000000, 42000000])
    await close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/app/assets-actions.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the actions**

Create `src/app/(app)/assets/actions.ts`. This is a **plain module, not a Server Action module** — it takes `db` as an argument so it is directly testable, and `db` is not serializable across the action boundary. The page wraps these in inline `'use server'` functions.

```typescript
import { eq, desc } from 'drizzle-orm'
import { manualAssets } from '@/db/schema'
import { dollarsToCents } from '@/lib/money'

export async function addManualAsset(db: any, input: {
  name: string; kind: string; isAsset: boolean; valueDollars: number; asOf: string
}) {
  await db.insert(manualAssets).values({
    name: input.name,
    kind: input.kind,
    isAsset: input.isAsset,
    value: dollarsToCents(input.valueDollars),
    asOf: input.asOf,
  })
}

/** Appends a new valuation row; never mutates an existing one. */
export async function revalueManualAsset(db: any, input: {
  name: string; valueDollars: number; asOf: string
}) {
  const [prior] = await db.select().from(manualAssets)
    .where(eq(manualAssets.name, input.name))
    .orderBy(desc(manualAssets.asOf))
    .limit(1)
  if (!prior) throw new Error(`No manual asset named ${input.name}`)

  await db.insert(manualAssets).values({
    name: prior.name,
    kind: prior.kind,
    isAsset: prior.isAsset,
    value: dollarsToCents(input.valueDollars),
    asOf: input.asOf,
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/app/assets-actions.test.ts`
Expected: PASS — both tests

- [ ] **Step 5: Build the page**

Create `src/app/(app)/assets/page.tsx`:

```tsx
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { manualAssets } from '@/db/schema'
import { formatCents } from '@/lib/money'
import { addManualAsset, revalueManualAsset } from './actions'

export default async function AssetsPage() {
  const rows = await db.select().from(manualAssets)

  // One entry per asset name, holding its most recent valuation.
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    const current = latest.get(r.name)
    if (!current || r.asOf > current.asOf) latest.set(r.name, r)
  }

  async function create(formData: FormData) {
    'use server'
    await addManualAsset(db, {
      name: String(formData.get('name')),
      kind: String(formData.get('kind')),
      isAsset: formData.get('isAsset') === 'on',
      valueDollars: Number(formData.get('value')),
      asOf: String(formData.get('asOf')),
    })
    revalidatePath('/assets')
  }

  async function revalue(formData: FormData) {
    'use server'
    await revalueManualAsset(db, {
      name: String(formData.get('name')),
      valueDollars: Number(formData.get('value')),
      asOf: String(formData.get('asOf')),
    })
    revalidatePath('/assets')
  }

  return (
    <main className="mx-auto max-w-3xl space-y-10 p-8">
      <section>
        <h1 className="mb-4 text-2xl font-semibold">Manual assets</h1>
        <ul className="divide-y">
          {[...latest.values()].map((a) => (
            <li key={a.name} className="flex items-baseline justify-between py-3">
              <span>
                {a.name}
                <span className="ml-2 text-sm text-neutral-500">
                  {a.isAsset ? 'asset' : 'liability'} · as of {a.asOf}
                </span>
              </span>
              <span className="tabular-nums">{formatCents(a.value)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 font-medium">Add</h2>
        <form action={create} className="grid grid-cols-2 gap-3">
          <input name="name" placeholder="Name" required className="rounded border p-2" />
          <select name="kind" className="rounded border p-2">
            <option value="property">Property</option>
            <option value="vehicle">Vehicle</option>
            <option value="retirement">Retirement</option>
            <option value="other">Other</option>
          </select>
          <input name="value" type="number" step="0.01" placeholder="Value in dollars"
                 required className="rounded border p-2" />
          <input name="asOf" type="date" required className="rounded border p-2" />
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input name="isAsset" type="checkbox" defaultChecked /> This is an asset (uncheck for a liability)
          </label>
          <button className="col-span-2 rounded bg-neutral-900 p-2 text-white">Add</button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 font-medium">Revalue</h2>
        <p className="mb-2 text-sm text-neutral-500">
          Adds a new valuation dated as-of. Past net worth is not rewritten.
        </p>
        <form action={revalue} className="grid grid-cols-3 gap-3">
          <select name="name" className="rounded border p-2">
            {[...latest.keys()].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <input name="value" type="number" step="0.01" placeholder="New value"
                 required className="rounded border p-2" />
          <input name="asOf" type="date" required className="rounded border p-2" />
          <button className="col-span-3 rounded bg-neutral-900 p-2 text-white">Revalue</button>
        </form>
      </section>
    </main>
  )
}
```

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/assets" tests/app/assets-actions.test.ts
git commit -m "feat: manual assets with append-only revaluation history"
```

---

### Task 11: Debts and goals

**Files:**
- Create: `src/app/(app)/debts/page.tsx`, `src/app/(app)/debts/actions.ts`
- Test: `tests/app/debts-actions.test.ts`

**Interfaces:**
- Consumes: schema (Task 1), `dollarsToCents`/`formatCents` (Task 2), `loadNetWorthInputs` (Task 9)
- Produces: `setDebtTerms(db, input: { accountId: string; aprPercent: number; minimumPaymentDollars: number; targetPayoff: string | null }): Promise<void>`, `addGoal(db, input: { name: string; targetAmountDollars: number; targetDate: string | null; linkedAccountId: string | null }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/app/debts-actions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../helpers/test-db'
import { setDebtTerms, addGoal } from '@/app/(app)/debts/actions'
import { accounts, debts, goals } from '@/db/schema'

describe('debts and goals', () => {
  it('stores APR as integer basis points and payment as cents', async () => {
    const { db, close } = await makeTestDb()
    const [a] = await db.insert(accounts)
      .values({ name: 'Car Loan', type: 'liability', isAsset: false }).returning()

    await setDebtTerms(db, {
      accountId: a.id, aprPercent: 5.25, minimumPaymentDollars: 412.5, targetPayoff: null,
    })

    const rows = await db.select().from(debts)
    expect(rows[0].aprBps).toBe(525)
    expect(rows[0].minimumPayment).toBe(41250)
    await close()
  })

  it('upserts terms for an account rather than duplicating', async () => {
    const { db, close } = await makeTestDb()
    const [a] = await db.insert(accounts)
      .values({ name: 'Car Loan', type: 'liability', isAsset: false }).returning()

    await setDebtTerms(db, { accountId: a.id, aprPercent: 5.25, minimumPaymentDollars: 412.5, targetPayoff: null })
    await setDebtTerms(db, { accountId: a.id, aprPercent: 4.0, minimumPaymentDollars: 400, targetPayoff: null })

    const rows = await db.select().from(debts)
    expect(rows).toHaveLength(1)
    expect(rows[0].aprBps).toBe(400)
    await close()
  })

  it('stores a goal target in cents', async () => {
    const { db, close } = await makeTestDb()
    await addGoal(db, {
      name: 'Emergency fund', targetAmountDollars: 15000, targetDate: '2027-01-01', linkedAccountId: null,
    })
    const rows = await db.select().from(goals)
    expect(rows[0].targetAmount).toBe(1500000)
    await close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/app/debts-actions.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the actions**

Create `src/app/(app)/debts/actions.ts`. Plain module, same rationale as Task 10 — the page supplies the `'use server'` wrappers.

```typescript
import { debts, goals } from '@/db/schema'
import { dollarsToCents } from '@/lib/money'

export async function setDebtTerms(db: any, input: {
  accountId: string; aprPercent: number; minimumPaymentDollars: number; targetPayoff: string | null
}) {
  const values = {
    accountId: input.accountId,
    aprBps: Math.round(input.aprPercent * 100),
    minimumPayment: dollarsToCents(input.minimumPaymentDollars),
    targetPayoff: input.targetPayoff,
  }
  await db.insert(debts).values(values).onConflictDoUpdate({
    target: debts.accountId,
    set: { aprBps: values.aprBps, minimumPayment: values.minimumPayment, targetPayoff: values.targetPayoff },
  })
}

export async function addGoal(db: any, input: {
  name: string; targetAmountDollars: number; targetDate: string | null; linkedAccountId: string | null
}) {
  await db.insert(goals).values({
    name: input.name,
    targetAmount: dollarsToCents(input.targetAmountDollars),
    targetDate: input.targetDate,
    linkedAccountId: input.linkedAccountId,
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/app/debts-actions.test.ts`
Expected: PASS — all 3 tests

- [ ] **Step 5: Build the page**

Create `src/app/(app)/debts/page.tsx`:

```tsx
import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { accounts, debts, goals } from '@/db/schema'
import { loadNetWorthInputs } from '@/lib/queries'
import { formatCents } from '@/lib/money'
import { setDebtTerms, addGoal } from './actions'

export default async function DebtsPage() {
  const liabilities = await db.select().from(accounts).where(eq(accounts.isAsset, false))
  const terms = await db.select().from(debts)
  const goalRows = await db.select().from(goals)
  const { snapshots } = await loadNetWorthInputs(db)

  // Latest snapshot balance per account.
  const balanceOf = new Map<string, { date: string; balance: number }>()
  for (const s of snapshots) {
    const current = balanceOf.get(s.accountId)
    if (!current || s.date > current.date) balanceOf.set(s.accountId, s)
  }
  const termsFor = new Map(terms.map((t) => [t.accountId, t]))

  async function saveTerms(formData: FormData) {
    'use server'
    const payoff = String(formData.get('targetPayoff') || '')
    await setDebtTerms(db, {
      accountId: String(formData.get('accountId')),
      aprPercent: Number(formData.get('apr')),
      minimumPaymentDollars: Number(formData.get('minimum')),
      targetPayoff: payoff || null,
    })
    revalidatePath('/debts')
  }

  async function createGoal(formData: FormData) {
    'use server'
    const date = String(formData.get('targetDate') || '')
    const linked = String(formData.get('linkedAccountId') || '')
    await addGoal(db, {
      name: String(formData.get('name')),
      targetAmountDollars: Number(formData.get('target')),
      targetDate: date || null,
      linkedAccountId: linked || null,
    })
    revalidatePath('/debts')
  }

  return (
    <main className="mx-auto max-w-3xl space-y-10 p-8">
      <section>
        <h1 className="mb-4 text-2xl font-semibold">Debts</h1>
        <ul className="divide-y">
          {liabilities.map((a) => {
            const t = termsFor.get(a.id)
            return (
              <li key={a.id} className="py-3">
                <div className="flex items-baseline justify-between">
                  <span>{a.name}</span>
                  <span className="tabular-nums">
                    {formatCents(balanceOf.get(a.id)?.balance ?? 0)}
                  </span>
                </div>
                <div className="text-sm text-neutral-500">
                  {t
                    ? `${(t.aprBps / 100).toFixed(2)}% APR · minimum ${formatCents(t.minimumPayment)}`
                    : 'No terms set'}
                </div>
                <form action={saveTerms} className="mt-2 grid grid-cols-4 gap-2">
                  <input type="hidden" name="accountId" value={a.id} />
                  <input name="apr" type="number" step="0.01" placeholder="APR %"
                         defaultValue={t ? t.aprBps / 100 : ''} className="rounded border p-1 text-sm" />
                  <input name="minimum" type="number" step="0.01" placeholder="Min payment"
                         defaultValue={t ? t.minimumPayment / 100 : ''} className="rounded border p-1 text-sm" />
                  <input name="targetPayoff" type="date" defaultValue={t?.targetPayoff ?? ''}
                         className="rounded border p-1 text-sm" />
                  <button className="rounded bg-neutral-900 p-1 text-sm text-white">Save</button>
                </form>
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h2 className="mb-4 text-2xl font-semibold">Goals</h2>
        <ul className="divide-y">
          {goalRows.map((g) => {
            const saved = g.linkedAccountId ? (balanceOf.get(g.linkedAccountId)?.balance ?? 0) : 0
            const pct = g.targetAmount > 0 ? Math.round((saved / g.targetAmount) * 100) : 0
            return (
              <li key={g.id} className="py-3">
                <div className="flex items-baseline justify-between">
                  <span>{g.name}</span>
                  <span className="tabular-nums">
                    {formatCents(saved)} / {formatCents(g.targetAmount)} ({pct}%)
                  </span>
                </div>
                {g.targetDate && (
                  <div className="text-sm text-neutral-500">Target {g.targetDate}</div>
                )}
              </li>
            )
          })}
        </ul>

        <form action={createGoal} className="mt-4 grid grid-cols-2 gap-3">
          <input name="name" placeholder="Goal name" required className="rounded border p-2" />
          <input name="target" type="number" step="0.01" placeholder="Target in dollars"
                 required className="rounded border p-2" />
          <input name="targetDate" type="date" className="rounded border p-2" />
          <select name="linkedAccountId" className="rounded border p-2">
            <option value="">No linked account</option>
            {liabilities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="col-span-2 rounded bg-neutral-900 p-2 text-white">Add goal</button>
        </form>
      </section>
    </main>
  )
}
```

The linked-account dropdown lists liability accounts here only because Phase 1 has no asset-account picker on this page; broaden it to all accounts once you have savings accounts synced.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — every test from Tasks 1–11

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/debts" tests/app/debts-actions.test.ts
git commit -m "feat: debt terms and savings goals entry"
```

---

## Done when

- `npm test` passes.
- A deployed Vercel instance syncs nightly and the dashboard shows a net worth figure you can verify by hand against your bank balances.
- A non-allowlisted signed-in user gets a 403.
- Re-running the sync produces no duplicate rows.

## Not in this plan

Phase 2 (AI chat and scenario modeling) and Phase 3 (briefings and flag detection) each get their own plan, written once this foundation is deployed and accumulating snapshots.
