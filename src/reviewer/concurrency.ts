/**
 * Run `fn` over `items` with at most `limit` in flight at once, returning
 * one Promise.allSettled-shaped result per item in input order. A rejecting
 * `fn` call never aborts the others — same fail-safe semantics callers get
 * from Promise.allSettled today, just with bounded concurrency instead of
 * firing every item at once.
 *
 * Exists because per-file LLM fan-out (info-gather, dedupe) used unbounded
 * `Promise.allSettled(items.map(...))`: a large PR with many files fired one
 * concurrent completion request per file, and a local model server that can
 * only serve a few requests at a time queued the rest until they hit the
 * client's per-call timeout.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const effectiveLimit = limit > 0 ? Math.min(limit, items.length) : items.length;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        const value = await fn(items[index], index);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, worker));
  return results;
}
