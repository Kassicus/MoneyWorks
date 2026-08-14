# Phase 1 — open items

Everything Phase 1 knowingly left open, why, and who has to decide it.
Written at merge time so the reasoning does not live only in a scratch directory.

Phase 1 shipped: 205 tests across 20 files, typecheck clean, 32 commits.

---

## 1. Nothing has run against real infrastructure

This is the honest boundary of what the test suite means.

Every database assertion runs against PGlite (Postgres compiled to WASM, in-process).
Every SimpleFIN call is a stub. No Vercel cron has ever fired. The React components
have never rendered — `recharts` is verified by the TypeScript compiler and nothing
else.

Specifically unexecuted:

- `applySync`'s `.returning()` on an `onConflictDoUpdate`, through the real
  `@neondatabase/serverless` driver. `src/sync/run.ts` reads `row.id` from it
  unguarded.
- The real SimpleFIN access-URL claim and fetch.
- `ResponsiveContainer` inside a fixed-height container — the single most common
  zero-height failure in recharts, and the chart is half the product.
- `next build`, which is the **only** enforcement point for the `server-only` guard
  on `src/lib/crypto.ts` and `src/lib/secrets.ts`, and the only check that the
  `functions` glob in `vercel.json` resolves to a real file. A glob matching nothing
  is a hard build error on Vercel.

**Do this first:** follow the `## Deploy` runbook in `README.md` end to end, run both
`curl` checks, and look at the dashboard. That converts three unknowns into evidence
and validates the runbook at the same time.

**Add CI** running `npm test`, `npm run typecheck`, and `next build`. Without it the
guards added this phase are conventions rather than gates.

---

## 2. Decisions that are yours, not the implementation's

### A closed account counts forever

Net worth carries each account's last known balance forward indefinitely, which is
correct and necessary — SimpleFIN does not report every account every day. But when
an account is genuinely **closed**, it simply stops appearing, and its final balance
keeps contributing on every future date.

"Absent from today's payload" cannot distinguish a closed account from an institution
having a bad night, and guessing wrong is costly in both directions: zero it out on
absence and one outage craters the chart; carry it forward and a closed account
inflates net worth permanently.

Needs an explicit signal — an `archived_at` the owner sets, or an absence-streak
threshold. It is a product decision about your data.

### A goal can be linked to a liability, and progress reads backwards

The goal picker offers every account. Link a credit card to "Pay off the car" and
progress reads `$892.10 / $12,000.00 (7%)` — paying the debt *down* moves the number
*away* from the target.

Fix is either filtering the picker to asset accounts, or adding a "paying down" goal
kind that subtracts. Both are product choices.

### Manual liabilities cannot carry debt terms

`debts.account_id` references `accounts.id` — the synced bank accounts. A private
loan entered by hand lives in `manual_assets`. So you can record a mortgage's balance
manually and cannot record its APR, minimum payment, or target payoff anywhere.

This is structural, from the original schema. For an app whose stated job includes
debt payoff progress, it will be exactly the debt you most want to track.

### Navigation does not exist

`/assets` and `/debts` are reachable only by typing the URL. The plan omitted
navigation entirely — it is nobody's task. Two of the three pages built this phase
are effectively invisible.

### Scaffolding files

`create-next-app` generated `AGENTS.md` and a one-line root `CLAUDE.md`. Neither was
requested. A root `CLAUDE.md` changes how agents behave in this repo going forward.
Left in place deliberately; removing them is a one-line decision.

---

## 3. Known-open technical items

**A finite-but-out-of-range `posted` timestamp still throws.** `isoDate` guards
`NaN` but not range. A milliseconds-instead-of-seconds value produces year 58567 —
a *valid* `Date`, so a `isNaN(getTime())` check never fires — and Postgres rejects it
with "time zone displacement out of range" **after** accounts and snapshots are
written. Needs a range check on the produced date, not a NaN check. Low severity: it
requires an upstream unit bug, fails loudly, and is recorded in `sync_runs`.

**`README.md`'s migration-0001 remedy is incomplete.** It gives the
nullable → backfill → `SET NOT NULL` steps but not drizzle's bookkeeping: after a
manual fix, the next `npm run db:migrate` retries `0001`, fails on "column already
exists", and `0002` never applies. The reader must also record `0001` as applied in
`drizzle.__drizzle_migrations`. Affects the upgrade path only, not a fresh deploy.

**Two overstated comments in `crypto.ts` / `secrets.ts`.** They claim a Client
Component import would inline the key into the browser bundle. It would not —
non-`NEXT_PUBLIC_` env vars are never inlined client-side. The `server-only` guard is
correct; the stated blast radius is not.

**Three implementations of "which valuation is current"** now exist:
`latestOnOrBefore`, `latestManualAssets`, and the `latest` map in
`loadDebtsAndGoals`. Two are documented as deliberately divergent on a full tie; the
third has no tiebreak at all. Not wrong today. Worth one shared helper before a
fourth appears — the first copy of this rule was a Critical bug in this phase.

**No non-negative CHECK on `debts.minimum_payment` or `goals.target_amount`.** Same
invariant class as the constraints added to `balance_snapshots.balance` and
`manual_assets.value`; enforced only in code.

**Unicode name handling is partial.** The duplicate-asset-name guard folds case,
whitespace, and NFC/NFD, but stripping U+200C/U+200D visibly alters emoji sequences
and Persian/Arabic text. `INVISIBLE` also misses U+200E/200F, U+00AD, and
U+202A–202E. Deferred deliberately: the harm needs a name containing a zero-width
joiner, and the table has no production rows.

**The action modules cannot defend the blank-vs-zero distinction for a future
non-form caller.** `Number('')` is `0`, so by the time a value reaches
`addManualAsset` or `setDebtTerms`, a blank field and a typed zero are identical.
`src/lib/form.ts` makes that distinction at the form layer, which is the only place
the information still exists. **If a CSV import, an API route, or a sync-side
revaluation is ever added, it must make that decision itself.**

---

## 4. Defects the review layer caught before merge

Recorded because they are the argument for keeping the review structure in Phase 2.
Every one of these was in the approved plan, and none would have crashed or failed a
test as originally written.

| Defect | Consequence if shipped |
|---|---|
| Middleware matcher excluded every dotted path | `/dashboard.rsc` served the dashboard payload unauthenticated, **in production only** — `next dev` 404s it, so the plan's own manual check could not have found it |
| Cron auth compared against `` `Bearer ${CRON_SECRET}` `` | With the env var unset, `Authorization: Bearer undefined` authenticated |
| `fetchAccounts` passed a credentialed URL to `fetch` | Node refuses userinfo URLs — the sync could never have run once — and the `TypeError` quoted the bank credential into logs |
| Cron handler was POST-only | Vercel triggers with GET; every nightly run would have 405'd silently |
| Manual assets keyed by row id | Net worth inflated on every revaluation — a house counted twice |
| Snapshots read their sign from the current account row | Paying a card into credit re-signed its **entire history**; $1,784 swing on every past date |
| Same-day revaluation returned the stale value | Correct a valuation in the afternoon, the dashboard shows the morning's |
| `chartDates` capped by walking forward | Chart froze permanently on day 366 while the headline kept moving |
| `Number('')` is `0`, in three files | A null bank balance turned a credit card into a $0.00 **asset** that vanished from the debt total |
| `formatCents` omitted at three render sites | `40000000` where `$400,000.00` belongs — including the headline figure, which passed all 198 tests |
| `formatCents(-0)` | `-$0.00` |

Two structural lessons worth carrying into Phase 2:

1. **A verification step that only runs locally cannot find a production-only bug.**
   Three of the above are invisible outside the deployed environment.
2. **On dates and timezones, verify by running, not by reasoning.** A reviewer, this
   plan, and I all agreed on a date assertion that turned out to pin nothing — broken
   only by executing the mutation under real timezones.
