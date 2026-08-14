// A build error, not a convention. This module reads `ENCRYPTION_KEY` and returns
// plaintext credentials; importing it from a Client Component would inline the key into
// the browser bundle. There are Client Components in this app now (`net-worth-chart.tsx`,
// `error.tsx`), so "server-side only" needed to stop being a sentence in a comment.
import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM for secrets at rest. Knows nothing about the database — the caller
 * decides where the three parts are stored.
 *
 * Never put a plaintext (or a key) into an error message here: these values are
 * credentials, and a thrown error can end up in a log or a response body.
 */

const ALGO = 'aes-256-gcm'

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY is not set')
  const buf = Buffer.from(raw, 'base64')
  // A wrong-length key must fail here rather than silently produce garbage ciphertext.
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded')
  return buf
}

export function encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  // A fresh IV per call is mandatory: reusing one under the same key breaks GCM's
  // confidentiality outright.
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext, iv, authTag: cipher.getAuthTag() }
}

export function decrypt(parts: { ciphertext: Buffer; iv: Buffer; authTag: Buffer }): string {
  // `authTagLength` is not decoration. Without it, `setAuthTag` accepts any GCM-legal tag
  // length — down to 4 bytes — and `final()` then verifies only the bytes it was given, so a
  // truncated tag is checked as a truncated tag. A 32-bit tag is forgeable by guessing; a
  // 128-bit one is not. Nothing in this app writes a short tag, which is the point: the row
  // being decrypted comes out of the database, and that is where a tampered tag would arrive
  // from. `encrypt` always emits 16 bytes, so this rejects rather than restricts.
  const decipher = createDecipheriv(ALGO, key(), parts.iv, { authTagLength: 16 })
  decipher.setAuthTag(parts.authTag)
  // `final()` throws if the auth tag does not match, so tampered ciphertext never decodes.
  return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString('utf8')
}
