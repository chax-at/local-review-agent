import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../src/reviewer/concurrency';

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` items at once', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return item;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('returns results in input order, matching Promise.allSettled shape', async () => {
    const items = [1, 2, 3, 4];
    const results = await mapWithConcurrency(items, 2, async (item) => item * 10);
    expect(results).toEqual([
      { status: 'fulfilled', value: 10 },
      { status: 'fulfilled', value: 20 },
      { status: 'fulfilled', value: 30 },
      { status: 'fulfilled', value: 40 },
    ]);
  });

  it("reports a rejected item without aborting the others (allSettled semantics)", async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrency(items, 2, async (item) => {
      if (item === 2) throw new Error('boom');
      return item;
    });
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
  });
});
