import { describe, it, expect, vi } from 'vitest';
import { ContextExplorer } from '../../src/reviewer/context-explorer';
import type { LlmClient } from '../../src/reviewer/llm-client';
import type { IInfoTool } from '../../src/reviewer/info-gatherer';

/** LLM that returns a different response per call (one call per exploration round). */
function mockLlmMulti(name: string, ...responses: string[]): LlmClient {
  const chat = vi.fn();
  for (const r of responses) chat.mockResolvedValueOnce({ content: r, inputTokens: 10, outputTokens: 5 });
  return { name, inputCostPer1M: 1, outputCostPer1M: 2, chat } as any;
}

function mockTools(over: Partial<IInfoTool> = {}): IInfoTool {
  return {
    readFile: vi.fn().mockResolvedValue(null),
    searchSymbol: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

const DIFF = 'diff --git a/src/feature.ts b/src/feature.ts\n+export function foo(): number { return bar(); }';

const NO_ACTIONS = '{"actions":[]}';

describe('ContextExplorer', () => {
  it('isEnabled false when no llm', () => {
    expect(new ContextExplorer(null, 8000).isEnabled).toBe(false);
  });

  it('isEnabled false when budget is 0', () => {
    expect(new ContextExplorer(mockLlmMulti('E1', NO_ACTIONS), 0).isEnabled).toBe(false);
  });

  it('returns empty context without calling the LLM when disabled', async () => {
    const llm = mockLlmMulti('E1', NO_ACTIONS);
    const disabled = new ContextExplorer(llm, 0);
    const res = await disabled.explore(DIFF, mockTools());
    expect(res.context).toBe('');
    expect(res.usage).toHaveLength(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('stops after one call when the first round proposes no actions', async () => {
    const llm = mockLlmMulti('E1', NO_ACTIONS);
    const explorer = new ContextExplorer(llm, 8000);
    const res = await explorer.explore(DIFF, mockTools());
    expect(res.context).toBe('');
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(res.usage).toHaveLength(1);
  });

  it('gathers file and search blocks and names usage with an (exploration) suffix', async () => {
    const llm = mockLlmMulti(
      'E1',
      '{"actions":[{"type":"file","target":"src/util.ts"},{"type":"search","target":"parseFoo"}]}',
      NO_ACTIONS,
    );
    const tools = mockTools({
      readFile: vi.fn().mockResolvedValue('export const util = 1;'),
      searchSymbol: vi.fn().mockResolvedValue([{ file: 'src/a.ts', line: 3, snippet: 'parseFoo(x)' }]),
    });
    const explorer = new ContextExplorer(llm, 8000);
    const res = await explorer.explore(DIFF, tools);

    expect(res.context).toContain('## File `src/util.ts`');
    expect(res.context).toContain('export const util = 1;');
    expect(res.context).toContain('## Search `parseFoo`');
    expect(res.context).toContain('src/a.ts:3: parseFoo(x)');
    expect(res.usage.every((u) => u.modelName === 'E1 (exploration)')).toBe(true);
    expect(res.usage).toHaveLength(2);
  });

  it('feeds gathered blocks into the next round so the model can follow leads', async () => {
    const llm = mockLlmMulti(
      'E1',
      '{"actions":[{"type":"file","target":"src/util.ts"}]}',
      '{"actions":[{"type":"search","target":"SecondLead"}]}',
      NO_ACTIONS,
    );
    const tools = mockTools({
      readFile: vi.fn().mockResolvedValue('UTIL_CONTENT calls SecondLead()'),
      searchSymbol: vi.fn().mockResolvedValue([{ file: 'src/b.ts', line: 7, snippet: 'SecondLead()' }]),
    });
    const explorer = new ContextExplorer(llm, 8000);
    const res = await explorer.explore(DIFF, tools);

    expect(llm.chat).toHaveBeenCalledTimes(3);
    // Round 2's user message must contain what round 1 gathered.
    const round2UserMessage = (llm.chat as any).mock.calls[1][1] as string;
    expect(round2UserMessage).toContain('UTIL_CONTENT');
    expect(res.context).toContain('UTIL_CONTENT');
    expect(res.context).toContain('## Search `SecondLead`');
  });

  it('stops at the round cap even when the model keeps proposing actions', async () => {
    const proposeFile = (p: string): string => `{"actions":[{"type":"file","target":"${p}"}]}`;
    const llm = mockLlmMulti('E1', proposeFile('a.ts'), proposeFile('b.ts'), proposeFile('c.ts'), proposeFile('d.ts'));
    const tools = mockTools({ readFile: vi.fn().mockResolvedValue('content') });
    const explorer = new ContextExplorer(llm, 8000);
    await explorer.explore(DIFF, tools);
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

  it('stops when a round only re-requests already-gathered targets', async () => {
    const proposeSame = '{"actions":[{"type":"file","target":"src/util.ts"}]}';
    const llm = mockLlmMulti('E1', proposeSame, proposeSame, proposeSame);
    const tools = mockTools({ readFile: vi.fn().mockResolvedValue('content') });
    const explorer = new ContextExplorer(llm, 8000);
    const res = await explorer.explore(DIFF, tools);

    expect(tools.readFile).toHaveBeenCalledTimes(1);
    // Round 2 produced nothing new, so no round 3 happens.
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(res.context).toContain('## File `src/util.ts`');
  });

  it('truncates blocks to the token budget and stops exploring once it is spent', async () => {
    const llm = mockLlmMulti(
      'E1',
      '{"actions":[{"type":"file","target":"src/big.ts"}]}',
      '{"actions":[{"type":"file","target":"src/never.ts"}]}',
    );
    const tools = mockTools({ readFile: vi.fn().mockResolvedValue('X'.repeat(500)) });
    // 10 tokens -> 40 char budget, far below the 500-char file.
    const explorer = new ContextExplorer(llm, 10);
    const res = await explorer.explore(DIFF, tools);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(res.context).toContain('X'.repeat(40));
    expect(res.context).not.toContain('X'.repeat(41));
  });

  it('returns the partial context when the LLM fails mid-loop', async () => {
    const chat = vi.fn();
    chat.mockResolvedValueOnce({
      content: '{"actions":[{"type":"file","target":"src/util.ts"}]}',
      inputTokens: 10,
      outputTokens: 5,
    });
    chat.mockRejectedValueOnce(new Error('boom'));
    const llm = { name: 'E1', inputCostPer1M: 1, outputCostPer1M: 2, chat } as any;
    const tools = mockTools({ readFile: vi.fn().mockResolvedValue('gathered before the crash') });
    const explorer = new ContextExplorer(llm, 8000);
    const res = await explorer.explore(DIFF, tools);

    expect(res.context).toContain('gathered before the crash');
    expect(res.usage).toHaveLength(1);
  });

  it('includes the PR intent in every round message when provided', async () => {
    const llm = mockLlmMulti('E1', '{"actions":[{"type":"file","target":"src/util.ts"}]}', NO_ACTIONS);
    const tools = mockTools({ readFile: vi.fn().mockResolvedValue('content') });
    const explorer = new ContextExplorer(llm, 8000);
    await explorer.explore(DIFF, tools, '# PR #9: migrate login to OAuth');

    const round1Message = (llm.chat as any).mock.calls[0][1] as string;
    const round2Message = (llm.chat as any).mock.calls[1][1] as string;
    expect(round1Message).toContain('migrate login to OAuth');
    expect(round2Message).toContain('migrate login to OAuth');
  });

  it('omits the intent section when none is provided', async () => {
    const llm = mockLlmMulti('E1', NO_ACTIONS);
    const explorer = new ContextExplorer(llm, 8000);
    await explorer.explore(DIFF, mockTools());
    const message = (llm.chat as any).mock.calls[0][1] as string;
    expect(message).not.toContain('PR intent');
  });

  it('returns empty context when the LLM response is unparseable', async () => {
    const llm = mockLlmMulti('E1', 'not json at all');
    const explorer = new ContextExplorer(llm, 8000);
    const res = await explorer.explore(DIFF, mockTools());
    expect(res.context).toBe('');
    expect(res.usage).toHaveLength(1);
  });
});
