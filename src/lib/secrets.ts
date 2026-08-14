// The "server-side only" below, enforced by the bundler rather than by whoever reads it:
// importing this from a Client Component is now a build error instead of a decrypted
// SimpleFIN access URL in a JavaScript bundle. `lib/crypto.ts` carries the same import.
import 'server-only'
import { eq } from 'drizzle-orm'
import { secrets } from '@/db/schema'
import type { Db } from '@/db/types'
import { encrypt, decrypt } from './crypto'

/**
 * The `secrets` table, encrypted at rest. Holds the SimpleFIN access URL, which *is*
 * the credential — anyone with it can read the full transaction history. Server-side
 * only: a plaintext returned by `getSecret` must never reach a browser or a log.
 */

export async function putSecret(db: Db, key: string, value: string): Promise<void> {
  const { ciphertext, iv, authTag } = encrypt(value)
  await db.insert(secrets)
    .values({ key, ciphertext, iv, authTag })
    .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, iv, authTag } })
}

export async function getSecret(db: Db, key: string): Promise<string | null> {
  const rows = await db.select().from(secrets).where(eq(secrets.key, key))
  if (rows.length === 0) return null
  const r = rows[0]
  return decrypt({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.authTag })
}
