/**
 * Maps `items` through `transform` with at most `limit` calls in flight and
 * returns the results in input order.
 *
 * Directory scans on the main process use this instead of `Promise.all` over
 * every entry: thousands of simultaneous fs requests complete in one burst,
 * and libuv hands the whole burst to JavaScript before timers or IPC get a
 * turn, which freezes the window just like the synchronous scan did.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  transform: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发上限无效')
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await transform(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
