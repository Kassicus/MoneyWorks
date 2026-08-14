import { config as loadEnvFiles } from 'dotenv'
import type { Config } from 'drizzle-kit'

/**
 * drizzle-kit reads `process.env` and nothing else — under `npm run db:migrate` that holds
 * only what the shell exported. Next, meanwhile, loads `.env.local` and `.env` itself. So an
 * owner who follows Next's own convention and puts `DATABASE_URL_UNPOOLED` in `.env.local`
 * gets a working `next dev` and a `db:migrate` that fails with `url: undefined` — with
 * nothing in either message connecting the two.
 *
 * Both files, `.env.local` first: dotenv never overwrites a variable that is already set, so
 * the first file to define a key wins — which is the precedence Next gives `.env.local`.
 * Missing files are not an error, so this is a no-op on Vercel, where the variables are
 * already in the environment.
 */
loadEnvFiles({ path: ['.env.local', '.env'], quiet: true })

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Migrations run against the DIRECT (unpooled) endpoint.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED! },
} satisfies Config
