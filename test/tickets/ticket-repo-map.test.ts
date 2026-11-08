import { describe, it, expect, vi } from 'vitest';
import { buildRepoMap, projectKeyOf, RepoPicker, type ITicketRepo } from '../../src/tickets/ticket-repo-map';

const cfg = (jiraProjects?: string[]) => ({ prReview: true, jiraProjects });

describe('buildRepoMap', () => {
  it('maps uppercase keys to the repos that claim them; ignores repos without config or without keys', () => {
    const map = buildRepoMap([
      { project: 'P', slug: 'api', config: cfg(['abc', 'CORE']) },
      { project: 'P', slug: 'web', config: cfg(['ABC']) },
      { project: 'P', slug: 'docs', config: cfg() },
      { project: 'P', slug: 'none', config: null },
    ]);
    expect(map.get('ABC')?.map((r) => r.slug)).toEqual(['api', 'web']);
    expect(map.get('CORE')?.map((r) => r.slug)).toEqual(['api']);
    expect(map.has('DOCS')).toBe(false);
  });
});

describe('projectKeyOf', () => {
  it('returns the uppercase prefix before the dash', () => {
    expect(projectKeyOf('abc-123')).toBe('ABC');
  });
});

describe('RepoPicker', () => {
  const candidates: ITicketRepo[] = [
    { project: 'P', slug: 'api', config: cfg(['ABC']) },
    { project: 'P', slug: 'web', config: cfg(['ABC']) },
  ];
  const ticket = { key: 'ABC-1', summary: 'Fix login form', description: 'The React form...' };

  it('returns the single candidate without calling the LLM', async () => {
    const llm = { name: 'L', chat: vi.fn(), inputCostPer1M: 0, outputCostPer1M: 0 } as never;
    const picker = new RepoPicker(llm);
    const result = await picker.pick(ticket, [candidates[0]]);
    expect(result.repo?.slug).toBe('api');
    expect((llm as { chat: ReturnType<typeof vi.fn> }).chat).not.toHaveBeenCalled();
  });

  it('returns the LLM pick when confidence is high and the slug is a candidate', async () => {
    const llm = {
      name: 'L',
      inputCostPer1M: 1,
      outputCostPer1M: 1,
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({ slug: 'web', confidence: 'high', reasoning: 'UI' }),
        inputTokens: 10,
        outputTokens: 5,
      }),
    } as never;
    const result = await new RepoPicker(llm).pick(ticket, candidates);
    expect(result.repo?.slug).toBe('web');
    expect(result.usage[0].modelName).toBe('L (repo picker)');
  });

  it('returns null on low confidence, on an unknown slug, and when no LLM is configured', async () => {
    const low = {
      name: 'L',
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({ slug: 'web', confidence: 'low', reasoning: '' }),
        inputTokens: 0,
        outputTokens: 0,
      }),
    } as never;
    expect((await new RepoPicker(low).pick(ticket, candidates)).repo).toBeNull();
    const unknown = {
      name: 'L',
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({ slug: 'other', confidence: 'high', reasoning: '' }),
        inputTokens: 0,
        outputTokens: 0,
      }),
    } as never;
    expect((await new RepoPicker(unknown).pick(ticket, candidates)).repo).toBeNull();
    expect((await new RepoPicker(null).pick(ticket, candidates)).repo).toBeNull();
  });

  it('returns null when the LLM throws', async () => {
    const llm = {
      name: 'L',
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      chat: vi.fn().mockRejectedValue(new Error('down')),
    } as never;
    expect((await new RepoPicker(llm).pick(ticket, candidates)).repo).toBeNull();
  });
});
