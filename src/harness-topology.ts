/**
 * Bounded worker pool (docs/harness/work-orders/G-topology.md, L3 body,
 * docs/harness/12-orchestration.md topologies). At most `concurrency` workers
 * run at once; results land in INPUT order regardless of completion order.
 * A rejecting worker becomes an `{ ok: false, error }` entry at its own index
 * and never affects the others -- one bad unit does not kill the pool.
 */

export type PoolResult<R> = { readonly ok: true; readonly value: R } | { readonly ok: false; readonly error: string };

export async function runPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<Array<PoolResult<R>>> {
  if (items.length === 0) return [];
  const size = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<PoolResult<R>>(items.length);
  let next = 0;

  async function lane(): Promise<void> {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        const value = await worker(items[i], i);
        results[i] = { ok: true, value };
      } catch (e) {
        results[i] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  await Promise.all(Array.from({ length: size }, () => lane()));
  return results;
}
