'use client'

/**
 * The boundary for every page in the app group.
 *
 * The manual-asset actions refuse bad input by throwing — a duplicate name, a blank name, a
 * negative value, an unknown asset, a caller who is not the owner. Without a boundary each of
 * those reaches the browser as an unhandled exception and the page is simply gone, with no way
 * back but the reload button. This turns them into a page the owner can retry from.
 *
 * `error.message` is deliberately **not** rendered. Next strips it in production anyway,
 * replacing it with the digest, but the reason to leave it out is the same one that keeps
 * `sync_runs.error` out of the dashboard's query: a throw from further down is a drizzle
 * error, and drizzle's messages embed the failing SQL together with its bound parameters —
 * account names, balances. The digest is printed instead, which is the key to the same error
 * in the Vercel function logs.
 *
 * The consequence to be honest about: the specific, useful sentences the actions throw —
 * `A manual asset named "House" already exists.` — do not reach the owner here either. They
 * reach the server log. Surfacing each one in place needs `useActionState` and client forms,
 * which is a larger change than this page; this is the floor, not the finished treatment.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-lg font-semibold">That did not work</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Something went wrong handling that request. Nothing was saved unless the page says
        otherwise, and your existing data is untouched.
      </p>
      <p className="mt-2 text-sm text-neutral-600">
        Common causes: a name that is already in use, a blank name, or a value that is not a
        positive number of dollars.
      </p>
      <button
        onClick={reset}
        className="mt-4 rounded bg-neutral-900 px-4 py-2 text-sm text-white"
      >
        Try again
      </button>
      {error.digest && (
        <p className="mt-4 text-xs text-neutral-400">
          Reference {error.digest} — find it in the Vercel function logs.
        </p>
      )}
    </main>
  )
}
