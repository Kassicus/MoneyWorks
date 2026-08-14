import type { Config } from 'drizzle-kit'

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Migrations run against the DIRECT (unpooled) endpoint.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED! },
} satisfies Config
