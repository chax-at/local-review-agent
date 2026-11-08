import { describe, it, expect, vi } from 'vitest';
import { parseLlmResponse, chatWithFallback } from '../../src/reviewer/llm-client';
import type { LlmClient } from '../../src/reviewer/llm-client';

function mockClient(name: string, chat: LlmClient['chat']): LlmClient {
  return { name, inputCostPer1M: 1, outputCostPer1M: 2, chat } as any;
}

describe('parseLlmResponse', () => {
  it('extracts content and token counts from OpenAI response', () => {
    const raw = {
      choices: [{ message: { content: 'hello world' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
    const result = parseLlmResponse(raw);
    expect(result.content).toBe('hello world');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it('handles missing usage gracefully', () => {
    const raw = { choices: [{ message: { content: 'hello' } }] };
    const result = parseLlmResponse(raw);
    expect(result.content).toBe('hello');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('handles empty/null response', () => {
    expect(parseLlmResponse(null).content).toBe('');
    expect(parseLlmResponse({}).content).toBe('');
    expect(parseLlmResponse({ choices: [] }).content).toBe('');
  });
});

describe('chatWithFallback', () => {
  it('returns the primary response and reports it as servedBy when the primary succeeds', async () => {
    const primary = mockClient('local-ai', vi.fn().mockResolvedValue({ content: 'ok', inputTokens: 1, outputTokens: 1 }));
    const fallback = mockClient('cloud', vi.fn());

    const { response, servedBy } = await chatWithFallback(primary, fallback, 'sys', 'user');

    expect(response.content).toBe('ok');
    expect(servedBy).toBe(primary);
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('retries the fallback and reports it as servedBy when the primary fails', async () => {
    const primary = mockClient('local-ai', vi.fn().mockRejectedValue(new Error('connection refused')));
    const fallback = mockClient('cloud', vi.fn().mockResolvedValue({ content: 'fallback ok', inputTokens: 2, outputTokens: 2 }));

    const { response, servedBy } = await chatWithFallback(primary, fallback, 'sys', 'user');

    expect(response.content).toBe('fallback ok');
    expect(servedBy).toBe(fallback);
  });

  it('rethrows the primary error when there is no fallback', async () => {
    const primary = mockClient('local-ai', vi.fn().mockRejectedValue(new Error('connection refused')));

    await expect(chatWithFallback(primary, null, 'sys', 'user')).rejects.toThrow('connection refused');
  });

  it('propagates a fallback failure too, once the primary has already failed', async () => {
    const primary = mockClient('local-ai', vi.fn().mockRejectedValue(new Error('primary down')));
    const fallback = mockClient('cloud', vi.fn().mockRejectedValue(new Error('fallback down')));

    await expect(chatWithFallback(primary, fallback, 'sys', 'user')).rejects.toThrow('fallback down');
  });

  it('does not race across concurrent calls sharing the same primary/fallback pair', async () => {
    // Two concurrent calls: one on a primary that fails (must resolve via
    // fallback), one on a primary that succeeds (must resolve via primary).
    // servedBy must reflect what actually served EACH call, not whichever
    // settled last — this is the correctness property the local-var (not
    // instance-state) design in chatWithFallback exists to guarantee.
    const flakyPrimary = mockClient(
      'flaky',
      vi.fn().mockRejectedValueOnce(new Error('flaked')).mockResolvedValueOnce({ content: 'second call ok', inputTokens: 1, outputTokens: 1 }),
    );
    const fallback = mockClient('cloud', vi.fn().mockResolvedValue({ content: 'fallback ok', inputTokens: 1, outputTokens: 1 }));

    const [first, second] = await Promise.all([
      chatWithFallback(flakyPrimary, fallback, 'sys', 'call-1'),
      chatWithFallback(flakyPrimary, fallback, 'sys', 'call-2'),
    ]);

    const servedByNames = [first.servedBy.name, second.servedBy.name].sort();
    expect(servedByNames).toEqual(['cloud', 'flaky']);
  });
});
