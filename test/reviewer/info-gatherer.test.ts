import { describe, it, expect, vi } from 'vitest';
import { InfoGatherer, type IInfoTool } from '../../src/reviewer/info-gatherer';
import type { LlmClient } from '../../src/reviewer/llm-client';
import type { IAuthoredFinding } from '../../src/types';

function mockLlm(name: string, response: string): LlmClient {
  return {
    name,
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    chat: vi.fn().mockResolvedValue({ content: response, inputTokens: 10, outputTokens: 5 }),
  } as any;
}

/** LLM that returns a different response per call (per-file gather makes N calls). */
function mockLlmMulti(name: string, ...responses: string[]): LlmClient {
  const chat = vi.fn();
  for (const r of responses) chat.mockResolvedValueOnce({ content: r, inputTokens: 10, outputTokens: 5 });
  return { name, inputCostPer1M: 1, outputCostPer1M: 2, chat } as any;
}

function authored(over: Partial<IAuthoredFinding> = {}): IAuthoredFinding {
  return {
    filePath: 'src/feature.ts',
    line: 12,
    severity: 'concern',
    comment: 'uses ComparisonEntry — does this DTO still expose jiraKey?',
    author: 'R1',
    ...over,
  };
}

function mockTools(over: Partial<IInfoTool> = {}): IInfoTool {
  return {
    readFile: vi.fn().mockResolvedValue(null),
    searchSymbol: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

const findingsMap = (...fs: IAuthoredFinding[]): Map<string, IAuthoredFinding[]> => {
  const m = new Map<string, IAuthoredFinding[]>();
  for (const f of fs) {
    const list = m.get(f.filePath);
    if (list) list.push(f);
    else m.set(f.filePath, [f]);
  }
  return m;
};

describe('InfoGatherer (per-file)', () => {
  it('isEnabled false when no llm', () => {
    expect(new InfoGatherer(null, 8000).isEnabled).toBe(false);
  });

  it('isEnabled false when budget is 0', () => {
    expect(new InfoGatherer(mockLlm('I1', '{}'), 0).isEnabled).toBe(false);
  });

  describe('gatherAll', () => {
    it('returns empty map when no llm', async () => {
      const g = new InfoGatherer(null, 8000);
      const res = await g.gatherAll(findingsMap(authored()), 'diff', new Map(), mockTools());
      expect(res.contextByFile.size).toBe(0);
      expect(res.usage).toHaveLength(0);
    });

    it('returns empty map when no findings', async () => {
      const llm = mockLlm('I1', '{"actions":[]}');
      const g = new InfoGatherer(llm, 8000);
      const res = await g.gatherAll(new Map(), 'diff', new Map(), mockTools());
      expect(res.contextByFile.size).toBe(0);
      expect(llm.chat).not.toHaveBeenCalled();
    });

    it('makes one LLM call per finding-file and routes each result to its file bucket', async () => {
      const llm = mockLlmMulti(
        'I1',
        '{"actions":[{"type":"file","target":"src/dto-a.ts"}]}',
        '{"actions":[{"type":"search","target":"FooBar"}]}',
      );
      const tools = mockTools({
        readFile: vi.fn().mockImplementation((p: string) => Promise.resolve(`CONTENT_OF_${p}`)),
        searchSymbol: vi
          .fn()
          .mockResolvedValue([{ file: 'src/b.ts', line: 3, snippet: 'class FooBar {}' }]),
      });
      const g = new InfoGatherer(llm, 8000);

      const findings = findingsMap(
        authored({ filePath: 'src/a.ts', line: 1, comment: 'A1' }),
        authored({ filePath: 'src/b.ts', line: 2, comment: 'B1' }),
      );
      const res = await g.gatherAll(findings, 'diff', new Map(), tools);

      expect(llm.chat).toHaveBeenCalledTimes(2);
      expect(res.contextByFile.size).toBe(2);
      expect(res.contextByFile.get('src/a.ts')).toContain('src/dto-a.ts');
      expect(res.contextByFile.get('src/a.ts')).toContain('CONTENT_OF_src/dto-a.ts');
      expect(res.contextByFile.get('src/b.ts')).toContain('FooBar');
      expect(res.contextByFile.get('src/b.ts')).toContain('class FooBar {}');
    });

    it('omits files for which the gather call returned no usable context', async () => {
      const llm = mockLlmMulti(
        'I1',
        '{"actions":[]}', // file a: nothing
        '{"actions":[{"type":"file","target":"src/dto.ts"}]}', // file b: ok
      );
      const tools = mockTools({ readFile: vi.fn().mockResolvedValue('dto-content') });
      const g = new InfoGatherer(llm, 8000);
      const res = await g.gatherAll(
        findingsMap(
          authored({ filePath: 'src/a.ts', comment: 'A' }),
          authored({ filePath: 'src/b.ts', comment: 'B' }),
        ),
        'diff',
        new Map(),
        tools,
      );
      expect(res.contextByFile.has('src/a.ts')).toBe(false);
      expect(res.contextByFile.has('src/b.ts')).toBe(true);
    });

    it('with onlyRequested=true, gathers only for files that have requests', async () => {
      const llm = mockLlm('I1', '{"actions":[{"type":"file","target":"src/dto.ts"}]}');
      const tools = mockTools({ readFile: vi.fn().mockResolvedValue('dto') });
      const g = new InfoGatherer(llm, 8000);

      const findings = findingsMap(
        authored({ filePath: 'src/a.ts' }),
        authored({ filePath: 'src/b.ts' }),
        authored({ filePath: 'src/c.ts' }),
      );
      const requests = new Map<string, string[]>([['src/b.ts', ['please load src/dto.ts']]]);
      const res = await g.gatherAll(findings, 'diff', new Map(), tools, requests, true);

      expect(llm.chat).toHaveBeenCalledTimes(1);
      expect(res.contextByFile.has('src/b.ts')).toBe(true);
      expect(res.contextByFile.has('src/a.ts')).toBe(false);
      expect(res.contextByFile.has('src/c.ts')).toBe(false);
    });

    it('with onlyRequested=false but requestsByFile present, gathers for all files and passes requests where they apply', async () => {
      const llm = mockLlmMulti(
        'I1',
        '{"actions":[{"type":"file","target":"src/dto-a.ts"}]}',
        '{"actions":[{"type":"file","target":"src/dto-b.ts"}]}',
      );
      const tools = mockTools({
        readFile: vi.fn().mockImplementation((p: string) => Promise.resolve(`X-${p}`)),
      });
      const g = new InfoGatherer(llm, 8000);

      const findings = findingsMap(
        authored({ filePath: 'src/a.ts' }),
        authored({ filePath: 'src/b.ts' }),
      );
      const requests = new Map<string, string[]>([['src/b.ts', ['need src/dto-b.ts']]]);

      await g.gatherAll(findings, 'diff', new Map(), tools, requests, false);

      expect(llm.chat).toHaveBeenCalledTimes(2);
      // The call for src/b.ts should see the validator request section.
      const callBodies = (llm.chat as any).mock.calls.map((c: any[]) => c[1] as string);
      const withRequests = callBodies.filter((b) => b.includes('Validator info requests'));
      expect(withRequests).toHaveLength(1);
      expect(withRequests[0]).toContain('need src/dto-b.ts');
    });

    it('budget is per file — each gather call gets its own ~maxInfoTokens*4 char cap', async () => {
      const big = 'X'.repeat(2000);
      const llm = mockLlmMulti(
        'I1',
        '{"actions":[{"type":"file","target":"big-a.ts"}]}',
        '{"actions":[{"type":"file","target":"big-b.ts"}]}',
      );
      const tools = mockTools({ readFile: vi.fn().mockResolvedValue(big) });
      const g = new InfoGatherer(llm, 100); // 400 char budget per call

      const res = await g.gatherAll(
        findingsMap(
          authored({ filePath: 'src/a.ts' }),
          authored({ filePath: 'src/b.ts' }),
        ),
        'diff',
        new Map(),
        tools,
      );

      const aChars = (res.contextByFile.get('src/a.ts') ?? '').length;
      const bChars = (res.contextByFile.get('src/b.ts') ?? '').length;
      // Each call independently capped — neither blob exceeds ~500 chars
      // (400 budget + ~50 framing + header).
      expect(aChars).toBeLessThanOrEqual(550);
      expect(bChars).toBeLessThanOrEqual(550);
      expect(aChars).toBeGreaterThan(0);
      expect(bChars).toBeGreaterThan(0);
    });

    it('runs per-file gather calls in parallel (does not wait for a slow file before starting the next)', async () => {
      const order: string[] = [];
      let resolveSlowA: (v: any) => void = () => {};
      const slowA = new Promise<{ content: string; inputTokens: number; outputTokens: number }>((resolve) => {
        resolveSlowA = resolve;
      });

      const chat = vi
        .fn()
        .mockImplementationOnce(async (_sys: string, body: string) => {
          order.push(body.includes('src/a.ts') ? 'a-start' : 'b-start');
          return slowA;
        })
        .mockImplementationOnce(async (_sys: string, body: string) => {
          order.push(body.includes('src/b.ts') ? 'b-start' : 'a-start');
          return { content: '{"actions":[]}', inputTokens: 1, outputTokens: 1 };
        });

      const llm = { name: 'I1', inputCostPer1M: 1, outputCostPer1M: 2, chat } as any as LlmClient;
      const g = new InfoGatherer(llm, 8000);

      const findings = findingsMap(
        authored({ filePath: 'src/a.ts' }),
        authored({ filePath: 'src/b.ts' }),
      );

      const allPromise = g.gatherAll(findings, 'diff', new Map(), mockTools());

      // Wait a tick so the second call definitely starts before A resolves
      await new Promise((r) => setTimeout(r, 5));
      expect(order).toContain('a-start');
      expect(order).toContain('b-start'); // would not be present yet if sequential

      resolveSlowA({ content: '{"actions":[]}', inputTokens: 1, outputTokens: 1 });
      await allPromise;
    });

    it('survives an unexpected throw from a single per-file gather without losing other files', async () => {
      // Use the same response for every LLM call so parallel-order doesn't
      // matter — both surviving calls produce identical context.
      const llm = mockLlm('I1', '{"actions":[{"type":"file","target":"src/dto.ts"}]}');
      const tools = mockTools({ readFile: vi.fn().mockResolvedValue('dto-content') });
      const g = new InfoGatherer(llm, 8000);

      // Patch gather so the call for src/a.ts throws while src/b.ts uses
      // the real implementation.
      const realGather = g.gather.bind(g);
      (g as any).gather = vi.fn().mockImplementation(async (filePath: string, ...rest: any[]) => {
        if (filePath === 'src/a.ts') throw new Error('boom from file a');
        return realGather(filePath, ...(rest as Parameters<typeof realGather>));
      });

      const res = await g.gatherAll(
        findingsMap(
          authored({ filePath: 'src/a.ts' }),
          authored({ filePath: 'src/b.ts' }),
        ),
        'diff',
        new Map(),
        tools,
      );

      // file a's throw is swallowed; file b still produces context
      expect(res.contextByFile.has('src/a.ts')).toBe(false);
      expect(res.contextByFile.has('src/b.ts')).toBe(true);
      expect(res.contextByFile.get('src/b.ts')).toContain('src/dto.ts');
    });

    it('aggregates usage from every per-file call', async () => {
      const llm = mockLlmMulti(
        'I1',
        '{"actions":[]}',
        '{"actions":[]}',
        '{"actions":[]}',
      );
      const g = new InfoGatherer(llm, 8000);
      const res = await g.gatherAll(
        findingsMap(
          authored({ filePath: 'a.ts' }),
          authored({ filePath: 'b.ts' }),
          authored({ filePath: 'c.ts' }),
        ),
        'diff',
        new Map(),
        mockTools(),
      );
      expect(res.usage).toHaveLength(3); // one usage entry per call
    });
  });

  describe('gather (single file)', () => {
    it('returns empty + no usage when the LLM call throws', async () => {
      const llm = {
        name: 'I1',
        inputCostPer1M: 1,
        outputCostPer1M: 2,
        chat: vi.fn().mockRejectedValue(new Error('boom')),
      } as any as LlmClient;
      const g = new InfoGatherer(llm, 8000);
      const res = await g.gather('src/a.ts', [authored()], 'diff', new Map(), mockTools());
      expect(res.context).toBe('');
      expect(res.usage).toHaveLength(0);
    });

    it('returns empty context when LLM response is unparseable but still records usage', async () => {
      const llm = mockLlm('I1', 'not json at all');
      const g = new InfoGatherer(llm, 8000);
      const res = await g.gather('src/a.ts', [authored()], 'diff', new Map(), mockTools());
      expect(res.context).toBe('');
      expect(res.usage).toHaveLength(1);
    });

    it('skips file actions for files that are already loaded', async () => {
      const llm = mockLlm('I1', '{"actions":[{"type":"file","target":"src/feature.ts"}]}');
      const tools = mockTools({ readFile: vi.fn().mockResolvedValue('SHOULD NOT APPEAR') });
      const loaded = new Map([['src/feature.ts', 'already here']]);
      const g = new InfoGatherer(llm, 8000);
      const res = await g.gather('src/feature.ts', [authored()], 'diff', loaded, tools);
      expect(tools.readFile).not.toHaveBeenCalled();
      expect(res.context).toBe('');
    });

    it('marks the user prompt with the file being processed', async () => {
      const llm = mockLlm('I1', '{"actions":[]}');
      const g = new InfoGatherer(llm, 8000);
      await g.gather('src/feature.ts', [authored()], 'diff', new Map(), mockTools());
      const body = (llm.chat as any).mock.calls[0][1] as string;
      expect(body).toContain('src/feature.ts');
    });

    it('when requests are passed, surfaces them in the user prompt', async () => {
      const llm = mockLlm('I1', '{"actions":[]}');
      const g = new InfoGatherer(llm, 8000);
      await g.gather('src/feature.ts', [authored()], 'diff', new Map(), mockTools(), ['src/dto.ts']);
      const body = (llm.chat as any).mock.calls[0][1] as string;
      expect(body).toContain('Validator info requests');
      expect(body).toContain('src/dto.ts');
    });
  });
});
