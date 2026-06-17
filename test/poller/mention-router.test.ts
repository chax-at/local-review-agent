import { describe, it, expect, vi } from 'vitest';
import { MentionRouteSchema, parseWithSchema } from '../../src/reviewer/llm-schemas';
import { MentionRouter } from '../../src/poller/mention-router';
import type { LlmClient } from '../../src/reviewer/llm-client';

describe('MentionRouteSchema', () => {
  it('parses a valid routing response', () => {
    const raw = '{"tool":"fix","message":"add null check","reasoning":"user asked to fix"}';
    const result = parseWithSchema(raw, MentionRouteSchema);
    expect(result).toEqual({ tool: 'fix', message: 'add null check', reasoning: 'user asked to fix' });
  });

  it('rejects invalid tool name', () => {
    const raw = '{"tool":"dance","message":"","reasoning":""}';
    expect(parseWithSchema(raw, MentionRouteSchema)).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(parseWithSchema('{"tool":"fix"}', MentionRouteSchema)).toBeNull();
  });
});

function mockLlm(name: string, response: string): LlmClient {
  return {
    name,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    chat: vi.fn().mockResolvedValue({ content: response, inputTokens: 10, outputTokens: 5 }),
  } as any;
}

function failingLlm(name: string): LlmClient {
  return {
    name,
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    chat: vi.fn().mockRejectedValue(new Error('network error')),
  } as any;
}

describe('MentionRouter', () => {
  it('routes using the first LLM in chain', async () => {
    const llm = mockLlm('Main', '{"tool":"fix","message":"add null check","reasoning":"user asked"}');
    const router = new MentionRouter([llm]);
    const result = await router.route('fix this');
    expect(result.tool).toBe('fix');
    expect(result.message).toBe('add null check');
  });

  it('falls back to second LLM when first fails', async () => {
    const bad = failingLlm('Main');
    const good = mockLlm('V1', '{"tool":"explain","message":"let me explain","reasoning":"question"}');
    const router = new MentionRouter([bad, good]);
    const result = await router.route('why did you flag this?');
    expect(result.tool).toBe('explain');
    expect(bad.chat).toHaveBeenCalledTimes(1);
  });

  it('falls back to default reply when all LLMs fail', async () => {
    const router = new MentionRouter([failingLlm('A'), failingLlm('B')]);
    const result = await router.route('hello');
    expect(result.tool).toBe('reply');
    expect(result.message).toContain('rephrase');
  });

  it('falls back to default when LLM returns unparseable response', async () => {
    const llm = mockLlm('Main', 'not json at all');
    const router = new MentionRouter([llm]);
    const result = await router.route('do something');
    expect(result.tool).toBe('reply');
  });

  it('generates conversational responses', async () => {
    const llm = mockLlm('Main', 'The null check is needed because...');
    const router = new MentionRouter([llm]);
    const response = await router.generateResponse(llm, 'why?', 'context here');
    expect(response).toContain('null check');
  });
});
