import { describe, it, expect } from 'vitest';
import { parsePiFindings, aggregateUsageFromPiOutput, buildLintScript, assertPiProducedResponse, buildProviderEnvArgs } from '../../src/reviewer/pi.service';

describe('parsePiFindings', () => {
  it('should extract findings from pi JSON output', () => {
    const piOutput = JSON.stringify({
      findings: [
        { filePath: 'src/foo.ts', line: 10, severity: 'warning', comment: 'Potential null reference' },
        { filePath: 'src/bar.ts', line: 25, severity: 'error', comment: 'SQL injection risk' },
      ],
    });

    const findings = parsePiFindings(piOutput);
    expect(findings).toHaveLength(2);
    expect(findings[0].filePath).toBe('src/foo.ts');
    expect(findings[0].severity).toBe('suggestion');
    expect(findings[1].severity).toBe('concern');
  });

  it('should normalize freeform severity values', () => {
    const piOutput = JSON.stringify({
      findings: [
        { filePath: 'a.ts', line: 1, severity: 'critical', comment: 'bad' },
        { filePath: 'b.ts', line: 2, severity: 'minor', comment: 'ok' },
        { filePath: 'c.ts', line: 3, severity: 'suggestion', comment: 'meh' },
      ],
    });

    const findings = parsePiFindings(piOutput);
    expect(findings[0].severity).toBe('concern');
    expect(findings[1].severity).toBe('note');
    expect(findings[2].severity).toBe('suggestion');
  });

  it('should skip malformed findings', () => {
    const piOutput = JSON.stringify({
      findings: [
        { filePath: 'a.ts', line: 'not-a-number', severity: 'warning', comment: 'bad' },
        { filePath: 'b.ts', line: 5, severity: 'info', comment: '' },
        { filePath: '', line: 1, severity: 'info', comment: 'no path' },
        { filePath: 'c.ts', line: 10, severity: 'warning', comment: 'valid' },
      ],
    });

    const findings = parsePiFindings(piOutput);
    expect(findings).toHaveLength(1);
    expect(findings[0].filePath).toBe('c.ts');
  });

  it('should return empty array for unparseable output', () => {
    expect(parsePiFindings('not json at all')).toEqual([]);
    expect(parsePiFindings('{}')).toEqual([]);
    expect(parsePiFindings('{"findings": "not array"}')).toEqual([]);
  });
});

describe('aggregateUsageFromPiOutput', () => {
  it('sums usage from message_end events (OpenAI-style keys)', () => {
    const out = [
      '{"type":"chunk","x":1}',
      '{"type":"message_end","usage":{"prompt_tokens":100,"completion_tokens":20}}',
      '{"type":"message_end","usage":{"prompt_tokens":50,"completion_tokens":10}}',
    ].join('\n');
    expect(aggregateUsageFromPiOutput(out)).toEqual({ inputTokens: 150, outputTokens: 30 });
  });

  it('accepts input_tokens / output_tokens aliases', () => {
    const out = '{"type":"message_end","usage":{"input_tokens":7,"output_tokens":3}}';
    expect(aggregateUsageFromPiOutput(out)).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('accepts pi native input / output keys', () => {
    const out = '{"type":"message_end","usage":{"input":7943,"output":2152,"cacheRead":0,"totalTokens":10095}}';
    expect(aggregateUsageFromPiOutput(out)).toEqual({ inputTokens: 7943, outputTokens: 2152 });
  });
});

describe('buildLintScript', () => {
  it('produces the expected shell snippet for ci:lint', () => {
    expect(buildLintScript('ci:lint')).toBe('cd /repo && npm run ci:lint');
  });

  it('produces the expected shell snippet for plain lint', () => {
    expect(buildLintScript('lint')).toBe('cd /repo && npm run lint');
  });
});

describe('assertPiProducedResponse', () => {
  it('throws when output contains no message_end events', () => {
    const output = '/workspace/run.sh: 7: pi: not found\n';
    expect(() => assertPiProducedResponse(output)).toThrowError(/pi: not found/);
  });

  it('throws with a useful empty marker when output is blank', () => {
    expect(() => assertPiProducedResponse('')).toThrowError(/\(empty\)/);
  });

  it('does not throw when output contains at least one message_end event', () => {
    const output = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '{"findings":[]}' }] },
    });
    expect(() => assertPiProducedResponse(output)).not.toThrow();
  });

  it('does not throw when an assistant message_end is mixed with other lines', () => {
    const output = [
      '{"type":"chunk","x":1}',
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '{"findings":[]}' }] },
        usage: { input: 10, output: 5 },
      }),
    ].join('\n');
    expect(() => assertPiProducedResponse(output)).not.toThrow();
  });

  it('throws when the only message_end is the user prompt echo (no assistant turn)', () => {
    // Regression: a `user` message_end has no stopReason; counting it as success
    // masks an assistant turn that errored (e.g. a 400 from a deprecated param).
    const output = [
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: [] } }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '400 bad param' },
      }),
    ].join('\n');
    expect(() => assertPiProducedResponse(output)).toThrowError(/400 bad param/);
  });

  it('throws and surfaces the error when every message_end is a provider error', () => {
    const errEvent = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '404 Not found' },
    });
    const output = [errEvent, errEvent].join('\n');
    expect(() => assertPiProducedResponse(output)).toThrowError(/404 Not found/);
  });

  it('does not throw when at least one message_end succeeds despite another erroring', () => {
    const errEvent = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 rate limited' },
    });
    const okEvent = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '{"findings":[]}' }] },
    });
    expect(() => assertPiProducedResponse([errEvent, okEvent].join('\n'))).not.toThrow();
  });
});

describe('buildProviderEnvArgs', () => {
  it('passes the Anthropic key under ANTHROPIC_API_KEY and no base (built-in)', () => {
    expect(buildProviderEnvArgs('anthropic', 'sk-ant-x', 'https://api.anthropic.com/v1/', 'claude-opus-4-8')).toEqual([
      '-e',
      'ANTHROPIC_API_KEY=sk-ant-x',
    ]);
  });

  it('passes the Gemini key under GEMINI_API_KEY and no base (built-in)', () => {
    expect(buildProviderEnvArgs('google', 'g-key', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3.1-pro')).toEqual([
      '-e',
      'GEMINI_API_KEY=g-key',
    ]);
  });

  it('keeps Azure key, base URL, and model env vars for azure-openai-responses', () => {
    expect(buildProviderEnvArgs('azure-openai-responses', 'az-key', 'https://x.openai.azure.com/openai/v1', 'gpt-5.5-1')).toEqual([
      '-e',
      'AZURE_OPENAI_API_KEY=az-key',
      '-e',
      'AZURE_OPENAI_BASE_URL=https://x.openai.azure.com/openai/v1',
      '-e',
      'AZURE_OPENAI_MODEL=gpt-5.5-1',
    ]);
  });

  it('omits the key env var when no API key is configured', () => {
    expect(buildProviderEnvArgs('anthropic', '', '', 'claude-opus-4-8')).toEqual([]);
  });
});

