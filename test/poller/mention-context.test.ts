import { describe, it, expect } from 'vitest';
import { buildMentionContext, sliceCodeAroundLine } from '../../src/poller/mention-context';

describe('sliceCodeAroundLine', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');

  it('returns ~150 lines centered on the target', () => {
    const result = sliceCodeAroundLine(lines, 100, 150);
    const resultLines = result.split('\n');
    expect(resultLines.length).toBeLessThanOrEqual(150);
    expect(result).toContain('line 100');
  });

  it('handles target near start of file', () => {
    const result = sliceCodeAroundLine(lines, 5, 150);
    expect(result).toContain('line 1');
    expect(result).toContain('line 5');
  });

  it('handles target near end of file', () => {
    const result = sliceCodeAroundLine(lines, 295, 150);
    expect(result).toContain('line 295');
    expect(result).toContain('line 300');
  });
});

describe('buildMentionContext', () => {
  it('builds context with all fields populated', () => {
    const ctx = buildMentionContext({
      mentionText: '@carrot fix this',
      parentComment: 'This looks wrong',
      siblingReplies: ['I agree'],
      anchorFile: 'src/app.ts',
      anchorLine: 42,
      anchorCode: 'const x = null;',
      botCommentOnAnchor: '🥕 **ERROR**: possible null deref',
      botCommentsOnPr: [{ path: 'src/app.ts', line: 42, text: '🥕 **ERROR**: possible null deref' }],
    });
    expect(ctx).toContain('@carrot fix this');
    expect(ctx).toContain('src/app.ts:42');
    expect(ctx).toContain('const x = null');
    expect(ctx).toContain('possible null deref');
  });

  it('omits sections when data is missing', () => {
    const ctx = buildMentionContext({
      mentionText: '@carrot hi',
      siblingReplies: [],
      botCommentsOnPr: [],
    });
    expect(ctx).toContain('@carrot hi');
    expect(ctx).not.toContain('## Code');
    expect(ctx).not.toContain('## Bot findings');
  });
});
