# MoneyWorks

A single-user personal finance dashboard. It syncs accounts from SimpleFIN nightly, tracks
manual assets, debts and savings goals, and shows one net worth figure derived from snapshot
history at read time — never stored, so correcting a balance corrects the whole chart.

Stack: Next.js on Vercel, Neon Postgres via Drizzle, Clerk for sign-in.

```
npm install
npm test          # no database and no network needed: Postgres is PGlite, fetch is stubbed
npm run typecheck
```

## Deploy

Do these in order. **Steps 3 and 4 both fail silently** — skip the migrations and every page
returns 500; skip the Clerk claim and you, the owner, get a bare `403 Forbidden` on every
page with everything else configured correctly. Neither failure names itself, and both look
exactly like a bug in the code.

### 1. Create the database

Create a Neon Postgres database and copy **both** connection strings:

| Variable                | Which endpoint                       | Used by                        |
| ----------------------- | ------------------------------------ | ------------------------------ |
| `DATABASE_URL`          | **Pooled** — the `-pooler` host       | The app, at every request      |
| `DATABASE_URL_UNPOOLED` | **Direct** — the host without `-pooler` | `npm run db:migrate` only    |

Migrations must not run through the pooler; the app must not run without it.

### 2. Set the environment variables

`.env.example` is the full list — copy it to `.env.local` for local work and add the same
keys to the Vercel project (Settings → Environment Variables) for the deploy.

| Variable                            | How to get it                                                   |
| ----------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`                      | Neon, pooled endpoint (step 1)                                   |
| `DATABASE_URL_UNPOOLED`             | Neon, direct endpoint (step 1)                                   |
| `ENCRYPTION_KEY`                    | `openssl rand -base64 32`                                        |
| `ALLOWED_EMAIL`                     | The one email address allowed to see anything                    |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API keys                                       |
| `CLERK_SECRET_KEY`                  | Clerk dashboard → API keys                                       |
| `CRON_SECRET`                       | `openssl rand -hex 32`                                           |
| `SIMPLEFIN_SETUP_TOKEN`             | SimpleFIN Bridge → "Connect an app". One-time; see the note below |

Two of these fail closed on purpose, so a blank value locks the app rather than opening it:

- `ENCRYPTION_KEY` must decode to exactly 32 bytes. A truncated paste throws the first time a
  secret is read or written, instead of encrypting the SimpleFIN credential under a key you
  cannot reproduce.
- `CRON_SECRET` unset or blank rejects **every** request to `/api/sync`, including Vercel's
  own. The sync stops; the route never opens up.

`SIMPLEFIN_SETUP_TOKEN` is claimed on the first sync only. The permanent access URL it
returns is encrypted into the `secrets` table and used forever after, so you can delete the
variable once a sync has succeeded. Claiming is single-use — a token that has already been
exchanged cannot be exchanged again.

### 3. Add the `email` claim to Clerk's session token

**This step is invisible if you skip it.** Clerk's default session token carries no `email`
claim, `ownerEmail()` answers null for every request, and the middleware returns
`403 Forbidden` to the legitimate owner on every page — with the correct `ALLOWED_EMAIL` set.

In the Clerk dashboard: **Configure → Sessions → Customize session token → Edit**, and set the
claims to exactly:

```json
{
  "email": "{{user.primary_email_address}}"
}
```

Save, then sign out and back in — an already-issued token does not gain the claim.

The email in that claim must equal `ALLOWED_EMAIL`. The comparison is trimmed and
case-insensitive, and nothing else about the account matters.

### 4. Run the migrations

**Nothing runs them for you.** `build` is `next build`; the deploy succeeds either way, and
the first request then fails on a missing table.

From a machine with the direct connection string:

```bash
DATABASE_URL_UNPOOLED='postgres://…neon.tech/moneyworks' npm run db:migrate
```

Or put `DATABASE_URL_UNPOOLED` in `.env.local` and run `npm run db:migrate` — the drizzle
config loads `.env.local` and `.env` itself.

Re-run this after any deploy that adds a file under `drizzle/`. It is safe to run when there
is nothing to apply.

> Putting `drizzle-kit migrate &&` in front of the `build` script would automate this, at the
> cost of running migrations from every preview deploy against whatever database that preview
> is pointed at. Deliberately not done here.

#### If migration `0001` fails on an existing database

Against a database that already holds `balance_snapshots` rows:

```
ERROR: column "is_asset" of relation "balance_snapshots" contains null values
```

The missing default is deliberate — any default sign is wrong for half the rows, and a
snapshot carrying the wrong sign silently rewrites past net worth, which is the bug that
column exists to fix. Apply it by hand as three statements instead:

```sql
ALTER TABLE "balance_snapshots" ADD COLUMN "is_asset" boolean;
UPDATE "balance_snapshots" s SET "is_asset" = a."is_asset"
  FROM "accounts" a WHERE a."id" = s."account_id";
ALTER TABLE "balance_snapshots" ALTER COLUMN "is_asset" SET NOT NULL;
```

The backfill copies each account's *current* classification onto its whole history. That is
the best guess available, and it is exactly the coupling this column removes going forward:
an account that has flipped between asset and liability has history that cannot be recovered.

A fresh database is unaffected: `0000` creates `balance_snapshots` empty, and adding a
`NOT NULL` column to a table with no rows needs no default. Only a database that was already
collecting snapshots before `0001` hits this.

### 5. Deploy, then verify the sync by hand

`vercel.json` schedules `GET /api/sync` at 09:00 UTC daily, and Vercel sends no session
cookie with it — the `CRON_SECRET` bearer token is that route's entire authentication. Check
it before waiting a night:

```bash
# GET — this is exactly what Vercel Cron sends.
curl -i -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/sync

# POST — the honest verb for a job that writes; both methods run the same job.
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/sync
```

Expected:

| Response                                           | Meaning                                          |
| -------------------------------------------------- | ------------------------------------------------ |
| `200` `{"ok":true,"accountsSeen":N,…}`             | Worked. `N` is what was in the payload, not what was newly written — a re-run reports the same counts. |
| `500` `{"ok":false,"error":"…"}`                   | The job ran and failed; the reason is in the body and in `sync_runs`. |
| `401 Unauthorized`                                  | The token did not match, or `CRON_SECRET` is unset on the server. |

Running it twice is safe: every write is an upsert keyed on a stable SimpleFIN id, which is
also how a half-finished run repairs itself the next night.

Then sign in and check the dashboard shows a net worth figure rather than the staleness
banner.

### If something is wrong

| Symptom                                             | Cause                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `403 Forbidden` on every page, for you              | The `email` claim is missing from the session token (step 3), or `ALLOWED_EMAIL` does not match it. |
| Every page 500s on a fresh deploy                   | Migrations were never run (step 4).                                 |
| Banner: "The nightly sync has never run"            | No request ever reached the job — usually `CRON_SECRET` unset in Vercel, which makes the route reject the cron before it can record a failure. |
| Banner: "running but never succeeding"              | The cron is firing and the job is failing. Look at the newest `sync_runs` row, or the function logs for `/api/sync`. An expired or already-claimed SimpleFIN token is the usual cause. |
| A `sync_runs` row stuck at `running`                | The function hit its `maxDuration` (60s, set in `vercel.json`) — the only failure mode where the job's own error handler never runs. |
