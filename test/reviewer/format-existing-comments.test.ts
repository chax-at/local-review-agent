import { describe, it, expect } from 'vitest';
import { formatExistingCommentsForReview } from '../../src/reviewer/reviewer.service';
import type { IComment } from '../../src/provider/provider.types';

const comment = (over: Partial<IComment> = {}): IComment => ({
  id: 1,
  text: 'hello',
  authorUsername: 'alice',
  replies: [],
  ...over,
});

describe('formatExistingCommentsForReview', () => {
  it('returns empty string for no comments', () => {
    expect(formatExistingCommentsForReview([])).toBe('');
  });

  it('groups anchored comments by file with author and line', () => {
    const out = formatExistingCommentsForReview([
      comment({ authorUsername: 'alice', text: 'looks wrong', anchor: { path: 'a.ts', line: 12 } }),
      comment({ authorUsername: 'bot', text: 'null deref', anchor: { path: 'a.ts', line: 20 } }),
    ]);
    expect(out).toContain('## Existing comments on `a.ts`:');
    expect(out).toContain('alice');
    expect(out).toContain('line 12');
    expect(out).toContain('looks wrong');
    expect(out).toContain('bot');
    expect(out).toContain('null deref');
  });

  it('separates comments from different files into different blocks', () => {
    const out = formatExistingCommentsForReview([
      comment({ text: 'A', anchor: { path: 'a.ts', line: 1 } }),
      comment({ text: 'B', anchor: { path: 'b.ts', line: 1 } }),
    ]);
    expect(out).toContain('## Existing comments on `a.ts`:');
    expect(out).toContain('## Existing comments on `b.ts`:');
  });

  it('puts non-anchored comments under a general discussion block', () => {
    const out = formatExistingCommentsForReview([
      comment({ authorUsername: 'carol', text: 'overall LGTM' }),
    ]);
    expect(out).toContain('## General discussion:');
    expect(out).toContain('carol');
    expect(out).toContain('overall LGTM');
  });

  it('skips comments whose text is empty or whitespace', () => {
    const out = formatExistingCommentsForReview([
      comment({ text: '   ', anchor: { path: 'a.ts', line: 1 } }),
    ]);
    expect(out).toBe('');
  });

  it('caps very long comment text', () => {
    const out = formatExistingCommentsForReview([
      comment({ text: 'x'.repeat(2000), anchor: { path: 'a.ts', line: 1 } }),
    ]);
    expect(out).toContain('## Existing comments on `a.ts`:');
    expect(out.match(/x+/)![0].length).toBeLessThanOrEqual(500);
  });

  it('caps the number of included comments at 60, keeping the most recent', () => {
    const comments = Array.from({ length: 200 }, (_, i) =>
      comment({ id: i, text: `comment-${i}`, anchor: { path: 'a.ts', line: i + 1 } }),
    );
    const out = formatExistingCommentsForReview(comments);
    // Most recent (highest index) kept, oldest dropped.
    expect(out).toContain('comment-199');
    expect(out).toContain('comment-140');
    expect(out).not.toContain('comment-139');
    expect(out).not.toContain('comment-0:');
    // The omission is announced so reviewers know context is partial.
    expect(out).toContain('140 older comment(s) omitted');
  });

  it('returns empty string when all comments within the cap are empty', () => {
    const comments = Array.from({ length: 100 }, () => comment({ text: '   ' }));
    expect(formatExistingCommentsForReview(comments)).toBe('');
  });
});
