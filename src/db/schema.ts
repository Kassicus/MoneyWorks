import { sql } from 'drizzle-orm'
import {
  pgTable, uuid, text, boolean, date, bigint, integer, timestamp, primaryKey, customType, check,
} from 'drizzle-orm/pg-core'

// Neon returns `bytea` as a Buffer; PGlite returns a Uint8Array. `fromDriver` normalises
// both to Buffer so the `data: Buffer` annotation is true on either driver — code that
// reads these columns (secrets decryption) can rely on Buffer methods in tests and in prod.
const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value: unknown): Buffer => {
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    throw new TypeError(`Expected bytea as Buffer or Uint8Array, got ${typeof value}`)
  },
})

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  simplefinId: text('simplefin_id').unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  isAsset: boolean('is_asset').notNull(),
  manual: boolean('manual').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// A snapshot is a historical record and must describe itself completely: `balance` is an
// unsigned magnitude, so the sign has to travel with the row. Reading it from `accounts`
// instead would mean a card refunded into credit — `is_asset` flipping to true today —
// retroactively adds every balance it used to subtract, silently rewriting past net worth.
export const balanceSnapshots = pgTable('balance_snapshots', {
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  date: date('date').notNull(),
  balance: bigint('balance', { mode: 'number' }).notNull(),
  isAsset: boolean('is_asset').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.accountId, t.date] }),
  // The positive-magnitude rule, in the one place that cannot be bypassed.
  //
  // `netWorthOn` *negates* every row whose `is_asset` is false, so a negative magnitude here
  // adds a debt to net worth instead of subtracting it — a swing of twice the balance, with
  // no crash and nothing on the page that looks wrong. Until this constraint, the sole
  // enforcement was `Math.abs()` in `sync/simplefin.ts`; three modules read these rows and
  // none of them re-checks the sign, so deleting that one call was a silent $400 error.
  balanceIsAMagnitude: check('balance_snapshots_balance_non_negative', sql`${t.balance} >= 0`),
}))

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
}, (t) => ({
  // Same rule as `balance_snapshots.balance`, same reason: a liability is entered as a
  // positive amount with the asset box unticked, and `netWorthOn` does the subtracting. A
  // negative value stored here counts a debt as an asset. `valuationCents` refuses one, and
  // this is the version that a second writer cannot forget.
  valueIsAMagnitude: check('manual_assets_value_non_negative', sql`${t.value} >= 0`),
}))

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
