import { describe, it, expect } from 'vitest';
import { parseLlmResponse } from '../../src/reviewer/llm-client';

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
