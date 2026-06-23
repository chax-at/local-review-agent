import { describe, it, expect } from 'vitest';
import { reviewCommitMarker, hasBotReviewForCommit } from '../../src/reviewer/review-marker';

describe('review-marker', () => {
  it('embeds the commit in a stable HTML-comment marker', () => {
    expect(reviewCommitMarker('abc123')).toBe('<!-- carrot-review commit=abc123 -->');
  });

  it('detects an existing bot review for the given commit', () => {
    const comments = [
      { authorUsername: 'human', text: 'looks good' },
      { authorUsername: 'bot', text: `Automated review: 2 finding(s)\n\n${reviewCommitMarker('deadbeef')}` },
    ];
    expect(hasBotReviewForCommit(comments, 'bot', 'deadbeef')).toBe(true);
  });

  it('does not match a different commit', () => {
    const comments = [{ authorUsername: 'bot', text: reviewCommitMarker('aaa111') }];
    expect(hasBotReviewForCommit(comments, 'bot', 'bbb222')).toBe(false);
  });

  it('ignores the marker when it is on a non-bot comment (no impersonation)', () => {
    const comments = [{ authorUsername: 'human', text: reviewCommitMarker('abc123') }];
    expect(hasBotReviewForCommit(comments, 'bot', 'abc123')).toBe(false);
  });

  it('returns false for an empty comment list', () => {
    expect(hasBotReviewForCommit([], 'bot', 'abc123')).toBe(false);
  });
});
