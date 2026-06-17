import { describe, it, expect, vi } from 'vitest';
import { FindingDeduplicator } from '../../src/reviewer/finding-deduplicator';
import type { LlmClient } from '../../src/reviewer/llm-client';
import type { IAuthoredFinding } from '../../src/types';

/** LLM that returns one response per call (per-file dedup makes one call per multi-finding file). */
function mockLlm(name: string, ...responses: string[]): LlmClient {
  const chat = vi.fn();
  for (const r of responses) chat.mockResolvedValueOnce({ content: r, inputTokens: 10, outputTokens: 5 });
  // Default for any extra calls: a single all-distinct response is unsafe to guess,
  // so leave unset — tests that call more than they queue will surface it.
  return { name, inputCostPer1M: 1, outputCostPer1M: 2, chat } as any;
}

function authored(over: Partial<IAuthoredFinding> = {}): IAuthoredFinding {
  return { filePath: 'a.ts', line: 1, severity: 'concern', comment: 'bug', author: 'R1', ...over };
}

const cluster = (clusters: Array<{ memberIndexes: number[]; mergedComment: string }>): string =>
  JSON.stringify({ clusters });

describe('FindingDeduplicator', () => {
  it('isEnabled is false when there is no llm', () => {
    expect(new FindingDeduplicator(null).isEnabled).toBe(false);
  });

  it('passes findings through unchanged when there is no llm', async () => {
    const d = new FindingDeduplicator(null);
    const findings = [authored(), authored({ author: 'R2' })];
    const result = await d.dedupe(findings);
    expect(result.findings).toHaveLength(2);
    expect(result.usage).toHaveLength(0);
    expect(result.mergedClusters).toBe(0);
  });

  it('makes no llm call when a file has only one finding', async () => {
    const llm = mockLlm('D1');
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([authored({ filePath: 'a.ts' })]);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(1);
  });

  it('makes no llm call when every file has a single finding', async () => {
    const llm = mockLlm('D1');
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([
      authored({ filePath: 'a.ts' }),
      authored({ filePath: 'b.ts' }),
    ]);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(2);
    expect(result.mergedClusters).toBe(0);
  });

  it('merges two duplicate findings on the same file into one with the llm-written comment', async () => {
    const llm = mockLlm('D1', cluster([{ memberIndexes: [0, 1], mergedComment: 'both reasons, kept' }]));
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([
      authored({ comment: 'null deref here', author: 'R1' }),
      authored({ comment: 'this can be null', author: 'R2' }),
    ]);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].comment).toBe('both reasons, kept');
    expect(result.findings[0].contributingAuthors).toEqual(['R1', 'R2']);
    expect(result.mergedClusters).toBe(1);
  });

  it('keeps both findings when the llm says they are distinct issues', async () => {
    const llm = mockLlm(
      'D1',
      cluster([
        { memberIndexes: [0], mergedComment: '' },
        { memberIndexes: [1], mergedComment: '' },
      ]),
    );
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([
      authored({ comment: 'issue one', author: 'R1' }),
      authored({ comment: 'issue two', author: 'R2' }),
    ]);
    expect(result.findings).toHaveLength(2);
    expect(result.mergedClusters).toBe(0);
    expect(result.findings[0].contributingAuthors).toBeUndefined();
    expect(result.findings.map((f) => f.comment).sort()).toEqual(['issue one', 'issue two']);
  });

  it('uses the highest severity and its line for the merged finding', async () => {
    const llm = mockLlm('D1', cluster([{ memberIndexes: [0, 1], mergedComment: 'merged' }]));
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([
      authored({ severity: 'note', line: 5, author: 'R1' }),
      authored({ severity: 'concern', line: 10, author: 'R2' }),
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('concern');
    expect(result.findings[0].line).toBe(10);
    expect(result.findings[0].contributingAuthors).toEqual(['R1', 'R2']);
  });

  it('breaks a severity tie by choosing the earliest line', async () => {
    const llm = mockLlm('D1', cluster([{ memberIndexes: [0, 1], mergedComment: 'merged' }]));
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([
      authored({ severity: 'concern', line: 9 }),
      authored({ severity: 'concern', line: 4 }),
    ]);
    expect(result.findings[0].line).toBe(4);
  });

  it('falls back to joining member comments when the llm returns an empty merged comment', async () => {
    const llm = mockLlm('D1', cluster([{ memberIndexes: [0, 1], mergedComment: '   ' }]));
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([
      authored({ comment: 'reason A', author: 'R1' }),
      authored({ comment: 'reason B', author: 'R2' }),
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].comment).toContain('reason A');
    expect(result.findings[0].comment).toContain('reason B');
  });

  it('keeps all findings unmerged when the llm response is unparseable (fail-safe)', async () => {
    const llm = mockLlm('D1', 'not json at all');
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([
      authored({ comment: 'A', author: 'R1' }),
      authored({ comment: 'B', author: 'R2' }),
    ]);
    expect(result.findings).toHaveLength(2);
    expect(result.mergedClusters).toBe(0);
    // usage is still recorded for the call that was made
    expect(result.usage).toHaveLength(1);
  });

  it('keeps all findings when the llm call throws (fail-safe)', async () => {
    const llm = { name: 'D1', inputCostPer1M: 1, outputCostPer1M: 2, chat: vi.fn().mockRejectedValue(new Error('boom')) } as any;
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([authored({ comment: 'A' }), authored({ comment: 'B' })]);
    expect(result.findings).toHaveLength(2);
    expect(result.usage).toHaveLength(0);
  });

  it('preserves a finding the llm forgot to assign to any cluster', async () => {
    const llm = mockLlm('D1', cluster([{ memberIndexes: [0], mergedComment: '' }]));
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([
      authored({ comment: 'A', author: 'R1' }),
      authored({ comment: 'B', author: 'R2' }),
    ]);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.comment).sort()).toEqual(['A', 'B']);
  });

  it('ignores out-of-range member indexes without crashing', async () => {
    const llm = mockLlm('D1', cluster([{ memberIndexes: [0, 1, 9], mergedComment: 'merged' }]));
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([authored({ author: 'R1' }), authored({ author: 'R2' })]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].contributingAuthors).toEqual(['R1', 'R2']);
  });

  it('only calls the llm for files that have 2+ findings', async () => {
    const llm = mockLlm('D1', cluster([{ memberIndexes: [0, 1], mergedComment: 'merged' }]));
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([
      authored({ filePath: 'a.ts', author: 'R1' }),
      authored({ filePath: 'a.ts', author: 'R2' }),
      authored({ filePath: 'b.ts', author: 'R1' }),
    ]);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    // a.ts -> 1 merged finding, b.ts -> 1 untouched finding
    expect(result.findings).toHaveLength(2);
    expect(result.mergedClusters).toBe(1);
  });

  it('records usage costed with the model rates', async () => {
    const llm = mockLlm('D1', cluster([{ memberIndexes: [0, 1], mergedComment: 'merged' }]));
    const d = new FindingDeduplicator(llm);
    const result = await d.dedupe([authored(), authored({ author: 'R2' })]);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0].modelName).toBe('D1');
    expect(result.usage[0].costEur).toBeGreaterThan(0);
  });
});
