/**
 * Runs `fn` over `items` with at most `limit` calls in flight, in order of
 * claim. Resolves once every item has settled; a rejection from `fn` ends the
 * whole run, so callers that want per-item isolation catch inside `fn`.
 */
export async function forEachConcurrent<T>(
  limit: number,
  items: readonly T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    }),
  );
}
