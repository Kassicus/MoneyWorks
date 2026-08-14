# MoneyWorks — Design

**Date:** 2026-08-13
**Status:** Approved

## Purpose

A personal finance dashboard whose primary job is answering **"am I making progress?"** — net worth over time, debt payoff, and savings goals — with Claude layered on top to interpret the numbers and help with financial decisions.

Single user (the repo owner). Hosted, so it is reachable from a phone and can run scheduled work.

## Goals

1. An accurate, automatically-updating net worth figure with real history.
2. Debt payoff and savings goal progress tracked against that history.
3. Four AI capabilities over the same financial context: on-demand chat, scheduled written briefings, scenario modeling, and flagged anomalies.

## Non-goals

- Multi-user support. The app is hardcoded to one allowlisted identity.
- Multi-currency. USD only; SimpleFIN serves US institutions.
- Historical backfill of net worth predating the first sync. History accrues forward from day one.
- A category taxonomy for spending analysis. Categorization exists only insofar as recurring-charge detection needs merchant grouping.
- Writing to financial accounts. The system is read-only against all external financial data.

## Architecture

Next.js (App Router) on Vercel, Neon Postgres, Clerk for auth. Three planes:

**Sync plane.** A Vercel Cron job invokes `/api/sync` daily at 09:00 UTC. It pulls accounts and transactions from SimpleFIN, upserts them, and writes one balance snapshot row per account per day. This job is the only writer of external financial data.

**Read plane.** Server Components query Postgres directly and render the dashboard. No financial records are fetched client-side.

**AI plane.** A single `buildFinancialContext()` function produces one structured snapshot of the user's finances. All four AI features are callers over that one payload — they differ in prompt and output shape, not in data access.

```
Vercel Cron ──> /api/sync ──> SimpleFIN ──> Postgres
                                              │
                            ┌─────────────────┴─────────────────┐
                            ▼                                   ▼
                   Server Components                  buildFinancialContext()
                   (dashboard render)                           │
                                                ┌───────┬───────┴───────┬────────┐
                                                ▼       ▼               ▼        ▼
                                              chat  briefing        scenario   flags
                                                └───────┴───────┬───────┴────────┘
                                                                ▼
                                                          Claude API
                                                     (server-side only)
```

### Database: Neon, provisioned through the Vercel Marketplace

Neon Free is sufficient with wide margin: 0.5 GB storage per project against an expected footprint under 100 MB after five years, and 100 CU-hours/month against an expected ~6.

Two consequences of Neon's architecture that the implementation must respect:

- **Connection pooling is mandatory.** Serverless functions open a connection per invocation and will exhaust a direct Postgres endpoint. The app connects through Neon's **pooled** connection string (the `-pooler` host) via `@neondatabase/serverless`. The direct endpoint is used only for migrations, which run once and outside request handling.
- **Scale-to-zero is expected, not a problem.** Compute suspends after 5 minutes idle and resumes automatically on the next connection in 500ms–2s; it cannot be disabled on the Free plan. The first dashboard load after a quiet period pays that cold start. This differs from a Supabase-style inactivity pause: nothing is ever permanently suspended and no manual restore is involved. The nightly cron wakes compute on its own schedule.

## Data model

```sql
accounts
  id                uuid pk
  simplefin_id      text unique null   -- null for manual accounts
  name              text
  type              text               -- checking | savings | credit | investment | loan | other
  is_asset          boolean            -- false => counts as a liability
  manual            boolean
  created_at        timestamptz

balance_snapshots
  account_id        uuid fk -> accounts
  date              date               -- UTC date of the sync run
  balance           numeric(14,2)
  primary key (account_id, date)

transactions
  id                uuid pk
  simplefin_id      text unique null   -- idempotency key for synced rows
  account_id        uuid fk -> accounts
  date              date
  amount            numeric(14,2)      -- signed; negative = money out
  description       text
  merchant          text null          -- normalized from description
  created_at        timestamptz

manual_assets
  id                uuid pk
  name              text
  kind              text               -- property | vehicle | retirement | other
  is_asset          boolean
  value             numeric(14,2)
  as_of             date
  created_at        timestamptz

debts
  account_id        uuid pk fk -> accounts
  apr               numeric(6,4)
  minimum_payment   numeric(14,2)
  target_payoff     date null

goals
  id                uuid pk
  name              text
  target_amount     numeric(14,2)
  target_date       date null
  linked_account_id uuid null fk -> accounts

briefings
  id                uuid pk
  period_start      date
  period_end        date
  generated_at      timestamptz
  markdown          text

insights
  id                uuid pk
  kind              text               -- new_recurring | savings_rate_decline | balance_anomaly
  severity          text               -- info | warn
  body              text
  detected_at       timestamptz
  dismissed_at      timestamptz null

sync_runs
  id                uuid pk
  started_at        timestamptz
  finished_at       timestamptz null
  status            text               -- ok | error
  error             text null

secrets
  key               text pk            -- e.g. 'simplefin_access_url'
  ciphertext        bytea              -- AES-256-GCM
  iv                bytea
  auth_tag          bytea
```

### Money representation

All monetary values are stored and manipulated as **integer cents** (`bigint` in Postgres, `number` in TypeScript), never as decimals or floats. Formatting to dollars happens only at the render boundary. This makes floating-point drift in net worth sums, amortization, and savings-rate math structurally impossible rather than merely unlikely.

The `numeric(14,2)` columns shown below are therefore `bigint` in the implementation; the schema listing keeps the semantic intent.

### Sign conventions

Balances are **normalized at ingest**: a liability account (`is_asset = false`) stores a positive magnitude of the amount owed, regardless of the sign SimpleFIN reports for it. Net worth subtracts those. Transaction `amount` keeps its natural sign — negative is money leaving the account.

### Net worth is derived, never stored

Net worth on date *D* =
`sum(balance where is_asset) − sum(balance where not is_asset)` over each account's most recent snapshot on or before *D*, plus each manual asset's most recent `as_of` row on or before *D* (added or subtracted per its `is_asset` flag).

Consequences:
- Correcting a wrong balance retroactively fixes the entire chart.
- `manual_assets` rows are append-only per revaluation, so updating a home's value does not rewrite the past to pretend that value always held.
- Accounts with no snapshot yet on date *D* contribute zero rather than erroring.

## Sync design

SimpleFIN's flow: a one-time setup token is exchanged for a permanent **access URL**, which is itself the credential. The exchange happens once via a setup page; the resulting URL is encrypted with AES-256-GCM (key from `ENCRYPTION_KEY`, a Vercel env var) and stored in `secrets`. It is decrypted only inside the sync job and never leaves the server.

Each run:
1. Insert a `sync_runs` row with status pending.
2. Fetch accounts and transactions since the last successful run (minus a 7-day overlap window, since institutions revise recent transactions).
3. Upsert accounts by `simplefin_id`.
4. Upsert transactions by `simplefin_id` — this makes re-runs idempotent and makes the overlap window safe.
5. Upsert one `balance_snapshots` row per account for today's UTC date.
6. Mark the run `ok`.

Errors: if SimpleFIN is unreachable or returns malformed data, the run is marked `error` with the message, and the dashboard renders a staleness banner ("last synced N days ago"). Steps 3–5 run inside a transaction so a partial failure leaves no half-written state. The job never deletes rows.

## AI layer

**Model: `claude-opus-5`.** Financial reasoning is the workload, and confidently-wrong answers about money are costly. Adaptive thinking is on by default on this model; no `thinking` parameter is required. All calls go through the official `@anthropic-ai/sdk` from server-side route handlers.

**Prompt caching.** `buildFinancialContext()` emits its stable prefix (schema description, account list, historical series) ahead of the volatile suffix (the user's current question), with a cache breakpoint at the boundary. Follow-up turns bill cached input at roughly a tenth of standard rate.

### The governing constraint: code computes, Claude interprets

No number the user relies on is produced by the model. Deterministic TypeScript computes; Claude explains.

| Feature | Computed in code | Produced by Claude |
|---|---|---|
| Chat | Read-only query tools return facts | Reasoning and the answer |
| Scenarios | Amortization and projection math | Explanation of the trade-off |
| Briefing | Period deltas, rates, goal progress | The written analysis |
| Flags | Rule-based detection | Human-readable card text |

**Chat.** A tool-use loop with three read-only tools: `get_net_worth_series(from, to)`, `get_account_balances()`, `query_transactions(filters)`. Responses stream to the client. The tool set contains no mutating operation, so a prompt injection carried in a transaction description cannot cause a state change.

**Scenarios.** The user sets assumptions (extra monthly payment, target date, rate change). A pure function computes the resulting amortization or projection curve. Both the assumptions and the computed result are passed to Claude, which explains the trade-off. Claude never receives a request to calculate.

**Briefings.** A monthly Vercel Cron job assembles the period's deltas and asks Claude for an analysis, stored as markdown in `briefings` and rendered in the dashboard.

**Flags.** Detection rules run in code after each sync:
- *new_recurring* — a merchant with ≥2 charges within 10% of the same amount at 28–33 day spacing, first seen in the last 60 days.
- *savings_rate_decline* — **net savings** (inflows minus outflows across checking and savings accounts for a calendar month) lower than the prior month for 3 consecutive months.
- *balance_anomaly* — a single-day balance change exceeding 3σ of that account's trailing 90-day daily changes **and** at least $500 in absolute terms, so low-variance accounts don't fire on noise.

Each detection is passed to Claude to write the card body, stored in `insights`, and dismissible.

### Cost

Context payload is roughly 15k tokens. At `claude-opus-5` rates ($5/$25 per million), a cold chat turn is about $0.11 and a cached follow-up about $0.04; a monthly briefing about $0.15. Expected usage lands between $1 and $6 per month.

## Security

The app is internet-reachable and holds a complete financial picture, so:

- **Clerk auth with a single-user email allowlist.** Middleware compares the authenticated user's primary email against `ALLOWED_EMAIL` and returns 403 on mismatch. Sign-up by anyone else yields an authenticated session with no access to anything.
- **SimpleFIN access URL encrypted at rest** (AES-256-GCM), decrypted only within the sync job.
- **`ANTHROPIC_API_KEY` is server-side only.** It is read in route handlers and never included in a client bundle or sent to the browser.
- **AI tools are read-only by construction.** There is no tool that writes, deletes, transfers, or edits. This is a structural guarantee, not a prompt instruction.
- **No financial data in client-side state beyond what is rendered.** No API route returns the raw account list to an unauthenticated caller.

## Error handling

| Failure | Behavior |
|---|---|
| SimpleFIN unreachable / malformed | `sync_runs.status = error`; dashboard shows staleness banner; no partial writes |
| Anthropic API error | Surfaced to the user with the error class; not retried silently on auth or billing errors |
| Anthropic rate limit / 5xx | SDK's built-in retry with backoff (default 2 retries) |
| Missing snapshot for an account on a date | Contributes zero to net worth on that date rather than erroring |
| Unauthenticated or non-allowlisted request | 403 before any database access |

## Testing

- **Unit** — net worth derivation across sparse snapshots and revalued manual assets; amortization and projection math; each of the three detection rules against fixture data.
- **Integration** — sync idempotency: run the same SimpleFIN payload twice, assert no duplicate transactions and one snapshot per account per day; sync failure leaves no partial writes.
- **Auth** — a request from a non-allowlisted email is rejected before reaching the data layer.
- **AI** — `buildFinancialContext()` produces a valid payload against fixture data; the exposed tool set contains no mutating tool. Model output text is not asserted on.

## Phasing

**Phase 1 — Foundation.** Schema and migrations, SimpleFIN setup and sync job, Clerk auth with allowlist, net worth dashboard with history chart, manual assets CRUD, debts and goals entry.

**Phase 2 — On-demand AI.** `buildFinancialContext()`, chat with read-only tools and streaming, scenario modeling with deterministic math plus explanation.

**Phase 3 — Scheduled AI.** Monthly briefing cron and rendering, the three detection rules, insight cards.

Phase 3 is last because both scheduled features are meaningless without accumulated history: a briefing over three days of data and a three-month savings-rate trend both require months of snapshots before they can state anything true.
