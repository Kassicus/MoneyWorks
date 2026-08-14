/**
 * Three readers over the element tree a Server Component returns.
 *
 * There is no jsdom and no testing-library in this project, and adding one to assert that a
 * figure is rendered as `$400,000.00` rather than `40000000` would be a large dependency for a
 * small question. A Server Component is an async function returning a plain tree of
 * `{ type, key, props }`, so the tree can simply be read.
 *
 * What this does *not* do is render: no hooks run, no client component is mounted, and layout
 * and CSS are out of reach. These answer "what text and which handlers does the tree carry",
 * which is enough to pin the money boundary and the auth gates, and nothing more.
 */

type Element = { type?: unknown; key?: unknown; props?: Record<string, unknown> }

const asElement = (node: unknown): Element | null =>
  typeof node === 'object' && node !== null ? (node as Element) : null

/** Every string and number in the tree, in document order, concatenated. */
export function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const el = asElement(node)
  // Booleans, null and undefined are what React renders as nothing — including the `false` a
  // short-circuited `{cond && <section/>}` leaves behind.
  return el?.props ? textOf(el.props.children) : ''
}

/** Every element of the given intrinsic type (`'li'`, `'form'`, …), in document order. */
export function findAll(node: unknown, type: string): Element[] {
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, type))
  const el = asElement(node)
  if (!el) return []
  const here = el.type === type ? [el] : []
  return [...here, ...(el.props ? findAll(el.props.children, type) : [])]
}

/** The text of each keyed element of a type, keyed by its React `key`. */
export function textByKey(node: unknown, type: string): Record<string, string> {
  return Object.fromEntries(
    findAll(node, type).map((el) => [String(el.key), textOf(el)]),
  )
}
