import { describe, it, expect, vi } from 'vitest';
import { FailureExplainer } from '../../src/reviewer/failure-explainer';
import type { LlmClient } from '../../src/reviewer/llm-client';

function mockClient(name: string, chat: LlmClient['chat']): LlmClient {
  return { name, inputCostPer1M: 1, outputCostPer1M: 2, chat } as any;
}

describe('FailureExplainer', () => {
  it('is disabled with no model, and degrades straight to the raw error text', async () => {
    const explainer = new FailureExplainer(null);
    expect(explainer.isEnabled).toBe(false);

    const { text, usage } = await explainer.explain('a'.repeat(600));
    expect(text).toHaveLength(500);
    expect(usage).toEqual([]);
  });

  it('returns the model explanation and its usage on success', async () => {
    const llm = mockClient(
      'Fable',
      vi.fn().mockResolvedValue({ content: '  Docker is unreachable.  ', inputTokens: 10, outputTokens: 5 }),
    );
    const explainer = new FailureExplainer(llm);
    expect(explainer.isEnabled).toBe(true);

    const { text, usage } = await explainer.explain('ECONNREFUSED at docker.sock');

    expect(text).toBe('Docker is unreachable.');
    expect(usage).toEqual([{ modelName: 'Fable (failure explainer)', inputTokens: 10, outputTokens: 5, costEur: 0.00002 }]);
  });

  it('falls back to the fallback model when the primary fails', async () => {
    const primary = mockClient('local-ai', vi.fn().mockRejectedValue(new Error('flaked')));
    const fallback = mockClient('cloud', vi.fn().mockResolvedValue({ content: 'network timeout', inputTokens: 1, outputTokens: 1 }));
    const explainer = new FailureExplainer(primary, fallback);

    const { text } = await explainer.explain('some error');
    expect(text).toBe('network timeout');
  });

  it('degrades to the raw error text (never throws) when both primary and fallback fail', async () => {
    const primary = mockClient('local-ai', vi.fn().mockRejectedValue(new Error('flaked')));
    const explainer = new FailureExplainer(primary, null);

    const { text, usage } = await explainer.explain('a specific raw error');
    expect(text).toBe('a specific raw error');
    expect(usage).toEqual([]);
  });

  it('falls back to the raw error text when the model returns an empty response', async () => {
    const llm = mockClient('Fable', vi.fn().mockResolvedValue({ content: '   ', inputTokens: 1, outputTokens: 1 }));
    const explainer = new FailureExplainer(llm);

    const { text } = await explainer.explain('raw error text');
    expect(text).toBe('raw error text');
  });
});
