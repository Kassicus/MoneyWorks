/**
 * The only writer of external financial data in this app: it takes an already-normalized
 * SimpleFIN payload and persists it — upserting accounts, appending transactions, and
 * writing one balance snapshot per account per day. Those snapshots are the spine; net
 * worth on any date is derived from them, so a snapshot written wrong is a wrong number
 * on the dashboard from that day forward.
 *
 * No network, no clock: the caller supplies the payload and the UTC date, which is what
 * makes the whole job deterministic and testable.
 *
 * ## This is NOT atomic. Do not read it as if it were.
 *
 * There is no transaction here and adding one would be worse than not having it. The
 * production driver is Neon's HTTP driver, which accepts `db.transaction(...)` at compile
 * time but does not provide interactive transactions at runtime: a wrapped version would
 * typecheck, pass these tests under PGlite, and silently guarantee nothing in production —
 * while making every future reader believe a failure rolls back. It does not. A run that
 * dies partway through leaves accounts upserted, some snapshots written and some not, and
 * some transactions inserted.
 *
 * **Idempotency is the recovery mechanism instead.** Every write is keyed on a stable
 * external identifier — `accounts.simplefin_id`, `transactions.simplefin_id`, and the
 * `(account_id, date)` primary key on `balance_snapshots` — so re-applying a payload
 * converges to the same state rather than duplicating it. The next night's run repairs
 * whatever a failed run left half-written, and a same-day re-run repairs it immediately.
 * That property is what the tests pin, and it is the thing to preserve when changing this.
 *
 * The three conflict policies differ on purpose:
 * - accounts: **update** — a name or a classification can change upstream and should refresh.
 *   That refresh is *current* state only; see the snapshot's own `isAsset` below for why
 *   moving it must not move the past with it.
 * - snapshots: **update** — the same day's balance can be revised by a later run that day.
 * - transactions: **do nothing** — a posted transaction is immutable; re-seeing it must not
 *   rewrite what was recorded the first time.
 */

import { accounts, balanceSnapshots, transactions } from '@/db/schema'
import type { Db } from '@/db/types'
import { normalizeAccountsResponse } from './simplefin'

export async function applySync(
  db: Db,
  payload: unknown,
  today: string,
): Promise<{ accounts: number; transactions: number }> {
  const normalized = normalizeAccountsResponse(payload)
  // `simplefin_id` is not the primary key: transactions reference accounts by internal uuid,
  // so the account upsert's `returning()` is the only source of the id to link them by.
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

    // `a.balance` is a positive magnitude even for a liability — the sign lives in
    // `isAsset`, and `netWorthOn` does the subtracting. That `isAsset` is written *onto the
    // snapshot*, not read back from the account later: the account row holds the current
    // classification and it moves, so sourcing the sign from it would let a card refunded
    // into credit retroactively add every balance it used to subtract. Both fields are
    // revised together on a same-day re-run, because a revised balance can change the
    // classification with it.
    await db.insert(balanceSnapshots)
      .values({ accountId: row.id, date: today, balance: a.balance, isAsset: a.isAsset })
      .onConflictDoUpdate({
        target: [balanceSnapshots.accountId, balanceSnapshots.date],
        set: { balance: a.balance, isAsset: a.isAsset },
      })
  }

  // Sequential, and after the account loop: each transaction needs the internal id that
  // loop put in the map. Nothing here is worth batching — this is one person's accounts.
  for (const t of normalized.transactions) {
    const accountId = idByExternal.get(t.simplefinAccountId)
    // Defensive, and unreachable today: `normalizeAccountsResponse` only ever emits a
    // transaction from inside the loop body of an account it has already emitted, so the
    // map always holds the key. Nothing is being dropped here now — do not read this
    // `continue` as evidence that transactions go missing. If normalization ever grows a
    // path that skips an account but keeps its transactions, skipping is still the right
    // answer (one orphan should not fail a whole run), but this branch would then need a
    // signal, because a silent `continue` is the one path here that reports nothing.
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
