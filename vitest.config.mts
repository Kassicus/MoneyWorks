import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      /**
       * Pinned, and pinned to a zone that is **not** UTC.
       *
       * Dates in this app are UTC throughout: snapshots are stamped with a UTC day and
       * `isoDate` reads SimpleFIN's `posted` in UTC, because a local-time reading misfiles an
       * evening transaction against the previous day's snapshot. The test that pins this
       * (`tests/sync/simplefin.test.ts`, "reads posted in UTC on both edges of the day") uses
       * two transactions either side of the UTC midnight — and it can only tell UTC from
       * local time when the host is somewhere else. On a UTC host, local time *is* UTC and
       * the assertion passes for a local-time implementation too.
       *
       * So the value matters: `TZ=UTC` would make the suite reproducible by making that test
       * tautological. `America/Denver` is UTC-6/-7, far enough west that a just-after-midnight
       * UTC transaction falls on the previous local day, and it observes DST, so a
       * naive-arithmetic date bug has somewhere to show up too.
       */
      TZ: 'America/Denver',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      /**
       * `src/lib/crypto.ts` and `src/lib/secrets.ts` import `server-only`, whose default
       * entry throws by design — that throw is what turns importing them from a Client
       * Component into a build error. Next resolves the package through the `react-server`
       * export condition instead, landing on its empty module; vitest resolves the default
       * one, so without this every test touching those modules dies at import.
       *
       * Aliased to the package's own `empty.js` — the same file Next uses on the server —
       * rather than to a stub, so nothing here has to be kept in step with the package.
       */
      'server-only': path.resolve(import.meta.dirname, './node_modules/server-only/empty.js'),
    },
  },
})
