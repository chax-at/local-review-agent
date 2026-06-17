import { describe, it, expect } from 'vitest';
import { parsePiFindings, aggregateUsageFromPiOutput, buildLintScript, parseFixProposal, parseFixProposalsBatch, assertPiProducedResponse } from '../../src/reviewer/pi.service';

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

describe('parseFixProposal', () => {
  it('parses a "replace" action from raw JSON', () => {
    const text = JSON.stringify({
      action: 'replace',
      replacement: 'const x = 1;\nconst y = 2;',
      startLine: 10,
      endLine: 11,
    });
    expect(parseFixProposal(text, 0)).toEqual({
      action: 'replace',
      findingIndex: 0,
      replacement: 'const x = 1;\nconst y = 2;',
      startLine: 10,
      endLine: 11,
    });
  });

  it('parses a "skip" action from raw JSON', () => {
    const text = JSON.stringify({ action: 'skip', reason: 'architectural concern' });
    expect(parseFixProposal(text, 3)).toEqual({
      action: 'skip',
      findingIndex: 3,
      reason: 'architectural concern',
    });
  });

  it('strips ```json fences before parsing', () => {
    const text = '```json\n{"action":"skip","reason":"no clean fix"}\n```';
    expect(parseFixProposal(text, 1)).toEqual({
      action: 'skip',
      findingIndex: 1,
      reason: 'no clean fix',
    });
  });

  it('returns a "skip" with parse-failure reason when JSON is garbled', () => {
    expect(parseFixProposal('not json at all', 2)).toEqual({
      action: 'skip',
      findingIndex: 2,
      reason: 'parse failure',
    });
  });

  it('returns a "skip" when required replace fields are missing', () => {
    const text = JSON.stringify({ action: 'replace', replacement: 'x' }); // no startLine/endLine
    expect(parseFixProposal(text, 4)).toEqual({
      action: 'skip',
      findingIndex: 4,
      reason: 'missing replace fields',
    });
  });

  it('returns a "skip" with default reason when action is unknown', () => {
    const text = JSON.stringify({ action: 'rewrite-everything' });
    expect(parseFixProposal(text, 5)).toEqual({
      action: 'skip',
      findingIndex: 5,
      reason: 'unknown action',
    });
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

  it('does not throw when output contains message_end mixed with other lines', () => {
    const output = [
      '{"type":"chunk","x":1}',
      JSON.stringify({ type: 'message_end', usage: { input: 10, output: 5 } }),
    ].join('\n');
    expect(() => assertPiProducedResponse(output)).not.toThrow();
  });
});

describe('parseFixProposalsBatch', () => {
  it('splits a multi-finding pi output by chunk separator and parses each section', () => {
    const sep = '===LGR_CHUNK_SEPARATOR===';
    const sectionA = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '{"action":"replace","replacement":"a","startLine":1,"endLine":1}' }] },
    });
    const sectionB = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '{"action":"skip","reason":"too vague"}' }] },
    });
    const output = `${sectionA}\n${sep}\n${sectionB}`;

    const proposals = parseFixProposalsBatch(output, 2);

    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ action: 'replace', findingIndex: 0, replacement: 'a' });
    expect(proposals[1]).toMatchObject({ action: 'skip', findingIndex: 1, reason: 'too vague' });
  });

  it('fills missing chunks with skip proposals', () => {
    const sectionA = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '{"action":"skip","reason":"no fix"}' }] },
    });
    const proposals = parseFixProposalsBatch(sectionA, 3);

    expect(proposals).toHaveLength(3);
    expect(proposals[0].action).toBe('skip');
    expect(proposals[1]).toEqual({ action: 'skip', findingIndex: 1, reason: 'no output' });
    expect(proposals[2]).toEqual({ action: 'skip', findingIndex: 2, reason: 'no output' });
  });

  it('treats a chunk with no assistant text as skip', () => {
    const sep = '===LGR_CHUNK_SEPARATOR===';
    const sectionA = JSON.stringify({ type: 'chunk', x: 1 }); // no message_end
    const sectionB = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '{"action":"skip","reason":"no clean fix"}' }] },
    });
    const proposals = parseFixProposalsBatch(`${sectionA}\n${sep}\n${sectionB}`, 2);

    expect(proposals[0]).toEqual({ action: 'skip', findingIndex: 0, reason: 'no assistant output' });
    expect(proposals[1]).toMatchObject({ action: 'skip', findingIndex: 1, reason: 'no clean fix' });
  });
});
