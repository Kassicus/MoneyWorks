import type { NeonHttpDatabase } from 'drizzle-orm/neon-http'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import type * as schema from './schema'

/**
 * The database handle every function in this codebase accepts.
 * A union of the production Neon client and the PGlite client used in tests,
 * so the same function can be exercised by both without widening to `any`.
 * Both imports are type-only and are erased at build time.
 */
export type Db = NeonHttpDatabase<typeof schema> | PgliteDatabase<typeof schema>
