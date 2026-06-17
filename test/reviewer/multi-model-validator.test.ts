import { describe, it, expect, vi } from 'vitest';
import { MultiModelValidator, pickRandom } from '../../src/reviewer/multi-model-validator';
import type { LlmClient } from '../../src/reviewer/llm-client';
import type { IReviewFinding, IAuthoredFinding } from '../../src/types';
import type { IFixProposal } from '../../src/reviewer/pi.service';

function mockClient(name: string, response: string): LlmClient {
  return {
    name,
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    chat: vi.fn().mockResolvedValue({ content: response, inputTokens: 10, outputTokens: 5 }),
  } as any;
}

/** Mock that returns different responses on successive calls (round 1, round 2, ...) */
function mockClientMultiRound(name: string, ...responses: string[]): LlmClient {
  const chatFn = vi.fn();
  for (const r of responses) {
    chatFn.mockResolvedValueOnce({ content: r, inputTokens: 10, outputTokens: 5 });
  }
  return { name, inputCostPer1M: 1, outputCostPer1M: 2, chat: chatFn } as any;
}

describe('pickRandom', () => {
  it('returns all items unchanged when n is 0 (no cap)', () => {
    const items = ['a', 'b', 'c'];
    const out = pickRandom(items, 0);
    expect(out).toEqual(items);
    expect(out).not.toBe(items); // fresh array (shallow copy)
  });

  it('returns all items unchanged when n exceeds length', () => {
    expect(pickRandom(['a', 'b'], 5).sort()).toEqual(['a', 'b']);
  });

  it('returns exactly n items when n < length', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const out = pickRandom(items, 2);
    expect(out).toHaveLength(2);
    for (const p of out) expect(items).toContain(p);
  });

  it('does not return duplicates', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    for (let trial = 0; trial < 50; trial++) {
      const out = pickRandom(items, 3);
      expect(new Set(out).size).toBe(out.length);
    }
  });

  it('does not mutate the input array', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const before = [...items];
    pickRandom(items, 2);
    expect(items).toEqual(before);
  });

  it('handles empty input', () => {
    expect(pickRandom([], 2)).toEqual([]);
  });
});

describe('MultiModelValidator.withRandomSubset', () => {
  const mc = (name: string) => ({ name, inputCostPer1M: 1, outputCostPer1M: 2, chat: vi.fn() } as any);

  it('returns a new instance with at most n models', () => {
    const v = new MultiModelValidator([mc('A'), mc('B'), mc('C'), mc('D')]);
    const subset = v.withRandomSubset(2);
    expect(subset).not.toBe(v);
    expect(subset.modelNames).toHaveLength(2);
    for (const name of subset.modelNames) expect(['A', 'B', 'C', 'D']).toContain(name);
  });

  it('returns the same instance when n is 0 (no cap)', () => {
    const v = new MultiModelValidator([mc('A'), mc('B')]);
    expect(v.withRandomSubset(0)).toBe(v);
  });

  it('includes all models when n exceeds the pool', () => {
    const v = new MultiModelValidator([mc('A'), mc('B')]);
    expect(v.withRandomSubset(5).modelNames.sort()).toEqual(['A', 'B']);
  });

  it('prefers non-deprioritized models when enough remain', () => {
    const v = new MultiModelValidator([mc('A'), mc('B'), mc('C'), mc('D')]);
    // A and B reviewed this PR (authors); 2 non-deprioritized remain and n=2,
    // so the validator subset must be exactly {C, D} — authors never sampled.
    const subset = v.withRandomSubset(2, ['A', 'B']);
    expect(subset.modelNames.sort()).toEqual(['C', 'D']);
  });

  it('falls back to deprioritized models when not enough preferred remain', () => {
    const v = new MultiModelValidator([mc('A'), mc('B'), mc('C'), mc('D')]);
    // Only D is non-deprioritized but n=3, so D is always picked plus 2 others.
    const subset = v.withRandomSubset(3, ['A', 'B', 'C']);
    expect(subset.modelNames).toHaveLength(3);
    expect(subset.modelNames).toContain('D');
  });

  it('treats an empty deprioritize list as a plain random subset', () => {
    const v = new MultiModelValidator([mc('A'), mc('B'), mc('C'), mc('D')]);
    expect(v.withRandomSubset(2, []).modelNames).toHaveLength(2);
  });

  it('uses only the picked subset for validateFindings — other models are not asked', async () => {
    const chats = ['A', 'B', 'C', 'D'].map((name) => mc(name));
    // Make all configured models return the same yes response so the test
    // only checks WHICH models were called, not vote outcomes.
    const yes = '{"results":[{"index":0,"relevant":true,"thought":"r","infoRequest":""}]}';
    for (const c of chats) {
      c.chat = vi.fn().mockResolvedValue({ content: yes, inputTokens: 1, outputTokens: 1 });
    }
    const v = new MultiModelValidator(chats);
    const subset = v.withRandomSubset(2);
    const subsetNames = new Set(subset.modelNames);

    await subset.validateFindings(
      [{ filePath: 'a.ts', line: 1, severity: 'concern' as const, comment: 'x', author: 'EXT' }],
      'diff',
      new Map(),
    );

    // Only the 2 picked models should have been called.
    const calledCount = chats.filter((c) => (c.chat as any).mock.calls.length > 0).length;
    expect(calledCount).toBe(2);
    for (const c of chats) {
      const called = (c.chat as any).mock.calls.length > 0;
      expect(called).toBe(subsetNames.has(c.name));
    }
  });
});

describe('MultiModelValidator', () => {
  const authored = (over: Partial<IAuthoredFinding> = {}): IAuthoredFinding => ({
    filePath: 'test.ts', line: 1, severity: 'concern', comment: 'bug', author: 'R1', ...over,
  });
  const noCtx = new Map<string, string>();

  describe('validateFindings', () => {
    it('returns all findings unchanged with no models', async () => {
      const v = new MultiModelValidator([]);
      const result = await v.validateFindings([authored()], 'diff', noCtx);
      expect(result.findings).toHaveLength(1);
      expect(result.usage).toHaveLength(0);
    });

    it('keeps findings when all models agree relevant', async () => {
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":true,"thought":"real bug","infoRequest":""}]}');
      const m2 = mockClient('M2', '{"results":[{"index":0,"relevant":true,"thought":"agreed","infoRequest":""}]}');
      const v = new MultiModelValidator([m1, m2]);
      const result = await v.validateFindings([authored()], 'diff', noCtx);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].validationNotes).toContain('M1');
      expect(result.findings[0].validationNotes).toContain('M2');
    });

    it('filters findings when all models say noise', async () => {
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":""}]}');
      const m2 = mockClient('M2', '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":""}]}');
      const v = new MultiModelValidator([m1, m2]);
      const result = await v.validateFindings([authored()], 'diff', noCtx);
      expect(result.findings).toHaveLength(0);
      expect(result.discardedRound1).toBe(1);
    });

    it('excludes the authoring model from voting on its own finding', async () => {
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":false,"thought":"should not be asked","infoRequest":""}]}');
      const m2 = mockClient('M2', '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":""}]}');
      const v = new MultiModelValidator([m1, m2]);
      const result = await v.validateFindings([authored({ author: 'M1' })], 'diff', noCtx);
      expect(m1.chat).not.toHaveBeenCalled();
      expect(m2.chat).toHaveBeenCalledTimes(1);
      expect(result.findings).toHaveLength(1);
    });

    it('excludes every contributing author of a merged finding from voting', async () => {
      // A merged finding (from the deduplicator) lists all models whose finding
      // contributed. None of them may vote, even though `author` names only one.
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":true,"thought":"x","infoRequest":""}]}');
      const m2 = mockClient('M2', '{"results":[{"index":0,"relevant":true,"thought":"x","infoRequest":""}]}');
      const m3 = mockClient('M3', '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":""}]}');
      const v = new MultiModelValidator([m1, m2, m3]);
      const merged = authored({ author: 'M1', contributingAuthors: ['M1', 'M2'] });
      const result = await v.validateFindings([merged], 'diff', noCtx);
      expect(m1.chat).not.toHaveBeenCalled();
      expect(m2.chat).not.toHaveBeenCalled();
      expect(m3.chat).toHaveBeenCalledTimes(1);
      expect(result.findings).toHaveLength(1);
    });

    it('conservatively keeps a finding when the only validator is its author', async () => {
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":""}]}');
      const v = new MultiModelValidator([m1]);
      const result = await v.validateFindings([authored({ author: 'M1' })], 'diff', noCtx);
      expect(m1.chat).not.toHaveBeenCalled();
      expect(result.findings).toHaveLength(1); // conservative keep — no eligible voters
      expect(result.findings[0].validationNotes).toBe('');
    });

    it('keeps a contested finding after deliberation when at least one model still defends it', async () => {
      const m1 = mockClientMultiRound('M1',
        '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":""}]}',
        '{"results":[{"index":0,"relevant":true,"thought":"still real","infoRequest":""}]}',
      );
      const m2 = mockClientMultiRound('M2',
        '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":""}]}',
        '{"results":[{"index":0,"relevant":false,"thought":"still noise","infoRequest":""}]}',
      );
      const v = new MultiModelValidator([m1, m2]);
      const result = await v.validateFindings([authored()], 'diff', noCtx);
      expect(result.findings).toHaveLength(1);
      expect(result.discardedRound2).toBe(0);
      expect(m1.chat).toHaveBeenCalledTimes(2);
      expect(m2.chat).toHaveBeenCalledTimes(2);
    });

    it('discards a contested finding only when all voters reject in round 2', async () => {
      const m1 = mockClientMultiRound('M1',
        '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":""}]}',
        '{"results":[{"index":0,"relevant":false,"thought":"changed mind","infoRequest":""}]}',
      );
      const m2 = mockClientMultiRound('M2',
        '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":""}]}',
        '{"results":[{"index":0,"relevant":false,"thought":"still noise","infoRequest":""}]}',
      );
      const v = new MultiModelValidator([m1, m2]);
      const result = await v.validateFindings([authored()], 'diff', noCtx);
      expect(result.findings).toHaveLength(0);
      expect(result.discardedRound2).toBe(1);
    });

    it('skips deliberation when unanimous from round 1', async () => {
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":""}]}');
      const m2 = mockClient('M2', '{"results":[{"index":0,"relevant":true,"thought":"agreed","infoRequest":""}]}');
      const v = new MultiModelValidator([m1, m2]);
      await v.validateFindings([authored()], 'diff', noCtx);
      expect(m1.chat).toHaveBeenCalledTimes(1);
      expect(m2.chat).toHaveBeenCalledTimes(1);
    });

    it('keeps findings when model returns unparseable response (no votes = keep)', async () => {
      const m1 = mockClient('M1', 'not json at all');
      const v = new MultiModelValidator([m1]);
      const result = await v.validateFindings([authored()], 'diff', noCtx);
      expect(result.findings).toHaveLength(1);
    });

    it('counts findings filtered in round 1 when all 3 validators say noise', async () => {
      const a = authored({ filePath: 'a.ts', comment: 'A' });
      const b = authored({ filePath: 'b.ts', comment: 'B' });
      const noise = '{"results":[{"index":0,"relevant":false,"thought":"n","infoRequest":""},{"index":1,"relevant":false,"thought":"n","infoRequest":""}]}';
      const v = new MultiModelValidator([mockClient('M1', noise), mockClient('M2', noise), mockClient('M3', noise)]);
      const result = await v.validateFindings([a, b], 'diff', noCtx);
      expect(result.findings).toHaveLength(0);
      expect(result.discardedRound1).toBe(2);
      expect(result.discardedRound2).toBe(0);
    });

    it('sends whole-file context when a file has 2+ findings', async () => {
      const a = authored({ filePath: 'multi.ts', line: 1, comment: 'A' });
      const b = authored({ filePath: 'multi.ts', line: 2, comment: 'B' });
      const yes = '{"results":[{"index":0,"relevant":true,"thought":"r","infoRequest":""},{"index":1,"relevant":true,"thought":"r","infoRequest":""}]}';
      const m1 = mockClient('M1', yes);
      const v = new MultiModelValidator([m1]);
      const ctx = new Map([['multi.ts', 'line1\nline2\nFULLFILEMARKER']]);
      await v.validateFindings([a, b], 'the-diff', ctx);
      const userMsg = (m1.chat as any).mock.calls[0][1] as string;
      expect(userMsg).toContain('Full file `multi.ts`');
      expect(userMsg).toContain('FULLFILEMARKER');
    });

    it('sends whole-file context even when a file has only one finding', async () => {
      const a = authored({ filePath: 'solo.ts', comment: 'A' });
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":true,"thought":"r","infoRequest":""}]}');
      const v = new MultiModelValidator([m1]);
      const ctx = new Map([['solo.ts', 'SOLOFILEMARKER']]);
      await v.validateFindings([a], 'UNIQUEDIFF', ctx);
      const userMsg = (m1.chat as any).mock.calls[0][1] as string;
      expect(userMsg).toContain('Full file `solo.ts`');
      expect(userMsg).toContain('SOLOFILEMARKER');
      expect(userMsg).not.toContain('UNIQUEDIFF');
    });

    it('falls back to diff context when a file has no whole-file content', async () => {
      const a = authored({ filePath: 'unknown.ts', comment: 'A' });
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":true,"thought":"r","infoRequest":""}]}');
      const v = new MultiModelValidator([m1]);
      await v.validateFindings([a], 'UNIQUEDIFF', new Map());
      const userMsg = (m1.chat as any).mock.calls[0][1] as string;
      expect(userMsg).toContain('UNIQUEDIFF');
      expect(userMsg).not.toContain('Full file');
    });

    it('injects per-file additionalContext only into that file\'s group prompt', async () => {
      const a = authored({ filePath: 'a.ts', line: 1, comment: 'A' });
      const b = authored({ filePath: 'b.ts', line: 1, comment: 'B' });
      const yes = '{"results":[{"index":0,"relevant":true,"thought":"r","infoRequest":""}]}';
      const m1 = mockClient('M1', yes);
      const v = new MultiModelValidator([m1]);
      const fileContent = new Map([
        ['a.ts', 'A-FILE-CONTENT'],
        ['b.ts', 'B-FILE-CONTENT'],
      ]);
      const additional = new Map([
        ['a.ts', 'CONTEXT_FOR_A_ONLY'],
        ['b.ts', 'CONTEXT_FOR_B_ONLY'],
      ]);
      await v.validateFindings([a, b], 'diff', fileContent, undefined, additional);
      const calls = (m1.chat as any).mock.calls.map((c: any[]) => c[1] as string);
      expect(calls).toHaveLength(2);
      // The call that mentions a.ts only has a's context, and vice versa.
      const aCall = calls.find((c) => c.includes('Full file `a.ts`'))!;
      const bCall = calls.find((c) => c.includes('Full file `b.ts`'))!;
      expect(aCall).toContain('CONTEXT_FOR_A_ONLY');
      expect(aCall).not.toContain('CONTEXT_FOR_B_ONLY');
      expect(bCall).toContain('CONTEXT_FOR_B_ONLY');
      expect(bCall).not.toContain('CONTEXT_FOR_A_ONLY');
    });

    it('omits the additional-context block when the map is empty', async () => {
      const a = authored();
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":true,"thought":"r","infoRequest":""}]}');
      const v = new MultiModelValidator([m1]);
      await v.validateFindings([a], 'diff', new Map(), undefined, new Map());
      const userMsg = (m1.chat as any).mock.calls[0][1] as string;
      expect(userMsg).not.toContain('Additional context');
    });

    it('runs the follow-up gather between rounds when round 1 produced info requests on a contested finding', async () => {
      const m1 = mockClientMultiRound(
        'M1',
        '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":"src/dto.ts"}]}',
        '{"results":[{"index":0,"relevant":true,"thought":"still real","infoRequest":""}]}',
      );
      const m2 = mockClientMultiRound(
        'M2',
        '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":"interface ComparisonEntry"}]}',
        '{"results":[{"index":0,"relevant":false,"thought":"still noise","infoRequest":""}]}',
      );
      const v = new MultiModelValidator([m1, m2]);

      const followUpGather = vi.fn().mockResolvedValue({
        contextByFile: new Map([['test.ts', 'FOLLOWUP_BLOB_MARKER']]),
        usage: [{ modelName: 'INFO', inputTokens: 11, outputTokens: 3, costEur: 0.001 }],
      });

      const result = await v.validateFindings(
        [authored()], // filePath defaults to test.ts in the local helper
        'diff',
        new Map(),
        undefined,
        new Map([['test.ts', 'ORIGINAL_CTX']]),
        followUpGather,
      );

      expect(followUpGather).toHaveBeenCalledTimes(1);
      // Requests are grouped by finding file
      const requestsByFile = followUpGather.mock.calls[0][0] as Map<string, string[]>;
      expect(requestsByFile.get('test.ts')).toEqual(
        expect.arrayContaining(['src/dto.ts', 'interface ComparisonEntry']),
      );

      // Round-2 prompts see merged context for test.ts
      const round2M1 = (m1.chat as any).mock.calls[1][1] as string;
      const round2M2 = (m2.chat as any).mock.calls[1][1] as string;
      expect(round2M1).toContain('ORIGINAL_CTX');
      expect(round2M1).toContain('FOLLOWUP_BLOB_MARKER');
      expect(round2M2).toContain('ORIGINAL_CTX');
      expect(round2M2).toContain('FOLLOWUP_BLOB_MARKER');

      expect(result.usage.some((u) => u.modelName === 'INFO')).toBe(true);
    });

    it('skips follow-up gather when all round-1 voters left infoRequest empty', async () => {
      const m1 = mockClientMultiRound(
        'M1',
        '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":""}]}',
        '{"results":[{"index":0,"relevant":true,"thought":"still real","infoRequest":""}]}',
      );
      const m2 = mockClientMultiRound(
        'M2',
        '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":""}]}',
        '{"results":[{"index":0,"relevant":false,"thought":"still noise","infoRequest":""}]}',
      );
      const v = new MultiModelValidator([m1, m2]);
      const followUpGather = vi.fn();
      await v.validateFindings([authored()], 'diff', new Map(), undefined, new Map(), followUpGather);
      expect(followUpGather).not.toHaveBeenCalled();
    });

    it('does not call follow-up gather when there are no split findings', async () => {
      const yes = '{"results":[{"index":0,"relevant":true,"thought":"r","infoRequest":"please fetch src/dto.ts"}]}';
      const v = new MultiModelValidator([mockClient('M1', yes), mockClient('M2', yes)]);
      const followUpGather = vi.fn();
      await v.validateFindings([authored()], 'diff', new Map(), undefined, new Map(), followUpGather);
      expect(followUpGather).not.toHaveBeenCalled();
    });

    it('falls back to the original additionalContext map when the follow-up gather throws', async () => {
      const m1 = mockClientMultiRound(
        'M1',
        '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":"src/dto.ts"}]}',
        '{"results":[{"index":0,"relevant":true,"thought":"still real","infoRequest":""}]}',
      );
      const m2 = mockClientMultiRound(
        'M2',
        '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":""}]}',
        '{"results":[{"index":0,"relevant":false,"thought":"still noise","infoRequest":""}]}',
      );
      const v = new MultiModelValidator([m1, m2]);
      const followUpGather = vi.fn().mockRejectedValue(new Error('boom'));

      const result = await v.validateFindings(
        [authored()],
        'diff',
        new Map(),
        undefined,
        new Map([['test.ts', 'ORIGINAL_CTX']]),
        followUpGather,
      );

      expect(followUpGather).toHaveBeenCalledTimes(1);
      const round2 = (m1.chat as any).mock.calls[1][1] as string;
      expect(round2).toContain('ORIGINAL_CTX');
      expect(result.findings).toHaveLength(1);
    });

    it('accepts a round-1 vote when the model omits infoRequest (lenient parse fallback)', async () => {
      // A model that doesn't support strict structured output may return the
      // base shape (no infoRequest field). It should still get a vote, just
      // with infoRequest treated as empty.
      const m1 = mockClient('M1', '{"results":[{"index":0,"relevant":true,"thought":"real bug"}]}');
      const m2 = mockClient('M2', '{"results":[{"index":0,"relevant":true,"thought":"agreed"}]}');
      const v = new MultiModelValidator([m1, m2]);
      const result = await v.validateFindings([authored()], 'diff', noCtx);
      expect(result.findings).toHaveLength(1); // both votes counted, finding kept
      expect(result.findings[0].validationNotes).toContain('**M1**');
      expect(result.findings[0].validationNotes).toContain('**M2**');
    });

    it('dedupes identical info requests within a file when forwarding to the gatherer', async () => {
      const m1 = mockClientMultiRound(
        'M1',
        '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":"src/dto.ts"}]}',
        '{"results":[{"index":0,"relevant":true,"thought":"still real","infoRequest":""}]}',
      );
      const m2 = mockClientMultiRound(
        'M2',
        '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":"src/dto.ts"}]}',
        '{"results":[{"index":0,"relevant":false,"thought":"still noise","infoRequest":""}]}',
      );
      const v = new MultiModelValidator([m1, m2]);
      const followUpGather = vi.fn().mockResolvedValue({ contextByFile: new Map(), usage: [] });

      await v.validateFindings([authored()], 'diff', new Map(), undefined, new Map(), followUpGather);
      expect(followUpGather).toHaveBeenCalledTimes(1);
      const requestsByFile = followUpGather.mock.calls[0][0] as Map<string, string[]>;
      expect(requestsByFile.get('test.ts')).toEqual(['src/dto.ts']);
    });
  });

  describe('validateFix', () => {
    it('approves with no models', async () => {
      const v = new MultiModelValidator([]);
      const result = await v.validateFix('fix this', 'diff');
      expect(result.approved).toBe(true);
    });

    it('approves when all models say no change needed', async () => {
      const m1 = mockClient('M1', '{"needsChange":false,"reason":"looks good"}');
      const m2 = mockClient('M2', '{"needsChange":false,"reason":"fine"}');
      const v = new MultiModelValidator([m1, m2]);
      const result = await v.validateFix('fix this', 'diff');
      expect(result.approved).toBe(true);
    });

    it('rejects when any model says change needed', async () => {
      const m1 = mockClient('M1', '{"needsChange":true,"reason":"missing null check"}');
      const m2 = mockClient('M2', '{"needsChange":false,"reason":"ok"}');
      const v = new MultiModelValidator([m1, m2]);
      const result = await v.validateFix('fix this', 'diff');
      expect(result.approved).toBe(false);
      expect(result.summary).toContain('missing null check');
    });

    it('skips validation when all models fail to parse', async () => {
      const m1 = mockClient('M1', 'garbage');
      const v = new MultiModelValidator([m1]);
      const result = await v.validateFix('fix this', 'diff');
      expect(result.approved).toBe(true);
      expect(result.summary).toContain('skipping');
    });
  });
});

describe('MultiModelValidator — per-model notes', () => {
  const authored2 = (over: Partial<IAuthoredFinding> = {}): IAuthoredFinding => ({
    filePath: 'a.ts', line: 1, severity: 'concern', comment: 'kept', author: 'R1', ...over,
  });
  const noCtx2 = new Map<string, string>();

  it('joins raw per-model thoughts into validationNotes for each kept finding', async () => {
    const yes = '{"results":[{"index":0,"relevant":true,"thought":"looks real","infoRequest":""}]}';
    const v = new MultiModelValidator([mockClient('V1', yes), mockClient('V2', yes)]);
    const result = await v.validateFindings([authored2()], 'diff', noCtx2);
    expect(result.findings[0].validationNotes).toContain('**V1**');
    expect(result.findings[0].validationNotes).toContain('**V2**');
    expect(result.findings[0].validationNotes).toContain('looks real');
  });

  it('groups per-model thoughts into Valid finding / Not important sections', async () => {
    // Note: with only 2 validators on a 1-vs-1 split, the finding goes to deliberation.
    // Make both stick to their stance in round 2 so we keep both sides in the rendered notes.
    const v = new MultiModelValidator([
      mockClientMultiRound('V1',
        '{"results":[{"index":0,"relevant":true,"thought":"genuine","infoRequest":""}]}',
        '{"results":[{"index":0,"relevant":true,"thought":"still genuine","infoRequest":""}]}',
      ),
      mockClientMultiRound('V2',
        '{"results":[{"index":0,"relevant":false,"thought":"noise","infoRequest":""}]}',
        '{"results":[{"index":0,"relevant":false,"thought":"still noise","infoRequest":""}]}',
      ),
    ]);
    const result = await v.validateFindings([authored2()], 'diff', noCtx2);
    expect(result.findings).toHaveLength(1);
    const notes = result.findings[0].validationNotes;
    expect(notes).toContain('**Valid finding:**');
    expect(notes).toContain('**Not important:**');
    expect(notes.indexOf('**Valid finding:**')).toBeLessThan(notes.indexOf('**Not important:**'));
    expect(notes).toContain('**V1**: genuine');
    expect(notes).toContain('**V2**: noise');
    expect(notes).toContain('**V1** (deliberation): still genuine');
    expect(notes).toContain('**V2** (deliberation): still noise');
  });

  it('omits no-response entries from rendered validationNotes (they carry no signal)', async () => {
    const yes = '{"results":[{"index":0,"relevant":true,"thought":"real","infoRequest":""}]}';
    const v = new MultiModelValidator([mockClient('V1', yes), mockClient('V2', '{"results":[]}'), mockClient('V3', yes)]);
    const result = await v.validateFindings([authored2()], 'diff', noCtx2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].validationNotes).not.toContain('V2');
    expect(result.findings[0].validationNotes).not.toContain('no response');
  });
});

describe('MultiModelValidator — validateSuggestions', () => {
  const finding1: IReviewFinding = { filePath: 'a.ts', line: 10, severity: 'concern', comment: 'fix me' };
  const finding2: IReviewFinding = { filePath: 'b.ts', line: 20, severity: 'suggestion', comment: 'tweak this' };
  const replaceProposal = (idx: number): IFixProposal => ({
    action: 'replace', findingIndex: idx, replacement: 'new code', startLine: 10, endLine: 10,
  });
  const skipProposal = (idx: number): IFixProposal => ({
    action: 'skip', findingIndex: idx, reason: 'no clean fix',
  });

  it('returns empty result when no replace proposals are given', async () => {
    const v = new MultiModelValidator([mockClient('M1', '{}')]);
    const result = await v.validateSuggestions(
      [finding1],
      [skipProposal(0)],
      new Map(),
    );
    expect(result.approvedSuggestions.size).toBe(0);
    expect(result.discardedRound1).toBe(0);
    expect(result.discardedRound2).toBe(0);
  });

  it('returns empty result when no validators are configured', async () => {
    const v = new MultiModelValidator([]);
    const result = await v.validateSuggestions(
      [finding1],
      [replaceProposal(0)],
      new Map([[0, 'context A']]),
    );
    expect(result.approvedSuggestions.size).toBe(0);
  });

  it('approves a suggestion when 3 validators agree round 1, no round-2 call', async () => {
    const yes = '{"results":[{"index":0,"relevant":true,"thought":"fits","infoRequest":""}]}';
    const m1 = mockClient('M1', yes);
    const m2 = mockClient('M2', yes);
    const m3 = mockClient('M3', yes);
    const v = new MultiModelValidator([m1, m2, m3]);

    const proposal = replaceProposal(0);
    const result = await v.validateSuggestions(
      [finding1],
      [proposal],
      new Map([[0, 'surrounding context for finding1']]),
    );

    expect(result.approvedSuggestions.get(0)).toEqual(proposal);
    expect(result.discardedRound1).toBe(0);
    expect(result.discardedRound2).toBe(0);
    expect(m1.chat).toHaveBeenCalledTimes(1);
    expect(m2.chat).toHaveBeenCalledTimes(1);
    expect(m3.chat).toHaveBeenCalledTimes(1);
  });

  it('discards a suggestion when all validators reject round 1', async () => {
    const no = '{"results":[{"index":0,"relevant":false,"thought":"bad fit","infoRequest":""}]}';
    const m1 = mockClient('M1', no);
    const m2 = mockClient('M2', no);
    const m3 = mockClient('M3', no);
    const v = new MultiModelValidator([m1, m2, m3]);

    const result = await v.validateSuggestions(
      [finding1],
      [replaceProposal(0)],
      new Map([[0, 'context']]),
    );

    expect(result.approvedSuggestions.size).toBe(0);
    expect(result.discardedRound1).toBe(1);
    expect(result.discardedRound2).toBe(0);
  });

  it('runs round-2 deliberation on a 2/1 split and approves on unanimous round 2', async () => {
    const m1 = mockClientMultiRound('M1',
      '{"results":[{"index":0,"relevant":true,"thought":"r1","infoRequest":""}]}',
      '{"results":[{"index":0,"relevant":true,"thought":"r2","infoRequest":""}]}',
    );
    const m2 = mockClientMultiRound('M2',
      '{"results":[{"index":0,"relevant":true,"thought":"r1","infoRequest":""}]}',
      '{"results":[{"index":0,"relevant":true,"thought":"r2","infoRequest":""}]}',
    );
    const m3 = mockClientMultiRound('M3',
      '{"results":[{"index":0,"relevant":false,"thought":"r1","infoRequest":""}]}',
      '{"results":[{"index":0,"relevant":true,"thought":"r2","infoRequest":""}]}',
    );
    const v = new MultiModelValidator([m1, m2, m3]);

    const proposal = replaceProposal(0);
    const result = await v.validateSuggestions(
      [finding1],
      [proposal],
      new Map([[0, 'context']]),
    );

    expect(result.approvedSuggestions.get(0)).toEqual(proposal);
    expect(result.discardedRound1).toBe(0);
    expect(result.discardedRound2).toBe(0);
    expect(m1.chat).toHaveBeenCalledTimes(2);
    expect(m2.chat).toHaveBeenCalledTimes(2);
    expect(m3.chat).toHaveBeenCalledTimes(2);
  });

  it('discards a suggestion when round-2 deliberation does not reach unanimity', async () => {
    const m1 = mockClientMultiRound('M1',
      '{"results":[{"index":0,"relevant":true,"thought":"r1","infoRequest":""}]}',
      '{"results":[{"index":0,"relevant":true,"thought":"r2","infoRequest":""}]}',
    );
    const m2 = mockClientMultiRound('M2',
      '{"results":[{"index":0,"relevant":true,"thought":"r1","infoRequest":""}]}',
      '{"results":[{"index":0,"relevant":false,"thought":"r2","infoRequest":""}]}',
    );
    const m3 = mockClientMultiRound('M3',
      '{"results":[{"index":0,"relevant":false,"thought":"r1","infoRequest":""}]}',
      '{"results":[{"index":0,"relevant":false,"thought":"r2","infoRequest":""}]}',
    );
    const v = new MultiModelValidator([m1, m2, m3]);

    const result = await v.validateSuggestions(
      [finding1],
      [replaceProposal(0)],
      new Map([[0, 'context']]),
    );

    expect(result.approvedSuggestions.size).toBe(0);
    expect(result.discardedRound1).toBe(0);
    expect(result.discardedRound2).toBe(1);
  });

  it('drops suggestions whose context is missing from the map', async () => {
    const yes = '{"results":[{"index":0,"relevant":true,"thought":"fits","infoRequest":""}]}';
    const m1 = mockClient('M1', yes);
    const m2 = mockClient('M2', yes);
    const v = new MultiModelValidator([m1, m2]);

    const result = await v.validateSuggestions(
      [finding1, finding2],
      [replaceProposal(0), replaceProposal(1)],
      new Map([[0, 'context-for-0']]), // index 1 missing → dropped
    );

    // Only finding 0 was eligible, and validators approved it.
    expect(result.approvedSuggestions.has(0)).toBe(true);
    expect(result.approvedSuggestions.has(1)).toBe(false);
  });

  it('drops the suggestion when all validators fail (network error)', async () => {
    const m1 = mockClient('M1', 'not json at all');
    const m2 = mockClient('M2', 'not json at all');
    const m3 = mockClient('M3', 'not json at all');
    const v = new MultiModelValidator([m1, m2, m3]);

    const result = await v.validateSuggestions(
      [finding1],
      [replaceProposal(0)],
      new Map([[0, 'context']]),
    );

    // No fallback approval — better to skip than risk a bad suggestion.
    expect(result.approvedSuggestions.size).toBe(0);
  });
});
