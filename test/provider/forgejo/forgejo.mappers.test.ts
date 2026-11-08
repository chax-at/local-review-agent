// test/provider/forgejo/forgejo.mappers.test.ts
import { describe, it, expect } from 'vitest';
import {
  forgejoLogin,
  toPullRequestForgejo,
  toBuildStatusForgejo,
  toRepoForgejo,
  toIssueCommentForgejo,
  toThreadAnchor,
  groupReviewComments,
  toReviewPositions,
  rewriteSuggestionFence,
  quoteReply,
} from '../../../src/provider/forgejo/forgejo.mappers';
import { isBotMention } from '../../../src/constants';
import type { IForgejoPullRequest, IForgejoReviewComment } from '../../../src/provider/forgejo/forgejo.types';

const basePr: IForgejoPullRequest = {
  number: 7,
  title: 'feat: x',
  body: 'PR body',
  state: 'open',
  draft: false,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T12:00:00Z',
  head: { ref: 'feature/x', sha: 'abc' },
  base: { ref: 'main' },
  user: { login: 'alice' },
  requested_reviewers: [{ login: 'carrot' }, { login: 'bob' }],
};

describe('forgejo.mappers.forgejoLogin', () => {
  it('returns the login, or an empty string for a missing (deleted) user', () => {
    expect(forgejoLogin({ login: 'alice' })).toBe('alice');
    expect(forgejoLogin(null)).toBe('');
    expect(forgejoLogin(undefined)).toBe('');
  });
});

describe('forgejo.mappers.toPullRequestForgejo', () => {
  it('maps the Forgejo PR shape to the neutral shape', () => {
    expect(toPullRequestForgejo(basePr)).toEqual({
      id: 7,
      title: 'feat: x',
      description: 'PR body',
      draft: false,
      isOpen: true,
      createdAt: Date.parse('2026-10-01T10:00:00Z'),
      updatedAt: Date.parse('2026-10-01T12:00:00Z'),
      sourceBranch: 'feature/x',
      sourceCommit: 'abc',
      targetBranch: 'main',
      authorUsername: 'alice',
      reviewerUsernames: ['carrot', 'bob'],
    });
  });

  it('maps draft, closed state, a null body, missing dates and missing reviewers', () => {
    const out = toPullRequestForgejo({
      ...basePr,
      body: null,
      state: 'closed',
      draft: true,
      created_at: null,
      updated_at: 'not a date',
      requested_reviewers: null,
      user: null,
    });
    expect(out.description).toBe('');
    expect(out.isOpen).toBe(false);
    expect(out.draft).toBe(true);
    expect(out.createdAt).toBeNull();
    expect(out.updatedAt).toBeNull();
    expect(out.reviewerUsernames).toEqual([]);
    expect(out.authorUsername).toBe('');
  });

  it('treats a missing draft field as not draft', () => {
    const { draft: _draft, ...noDraft } = basePr;
    expect(toPullRequestForgejo(noDraft).draft).toBe(false);
  });
});

describe('forgejo.mappers.toBuildStatusForgejo', () => {
  it('maps every Forgejo status to the neutral state', () => {
    const map = (status: 'pending' | 'success' | 'error' | 'failure' | 'warning') =>
      toBuildStatusForgejo({ status, target_url: 'https://ci/1', context: 'ci/build' }).state;
    expect(map('success')).toBe('successful');
    expect(map('failure')).toBe('failed');
    expect(map('error')).toBe('failed');
    expect(map('pending')).toBe('in_progress');
    expect(map('warning')).toBe('in_progress');
  });

  it('uses the target URL and context, with empty strings when missing', () => {
    expect(toBuildStatusForgejo({ status: 'success', target_url: 'https://ci/1', context: 'ci/build' })).toEqual({
      state: 'successful',
      url: 'https://ci/1',
      key: 'ci/build',
    });
    expect(toBuildStatusForgejo({ status: 'success' })).toEqual({ state: 'successful', url: '', key: '' });
  });
});

describe('forgejo.mappers.toRepoForgejo', () => {
  it('uses the repo name as slug and the owner login as project key', () => {
    expect(toRepoForgejo({ name: 'api', owner: { login: 'chax' } })).toEqual({ slug: 'api', projectKey: 'chax' });
  });
});

describe('forgejo.mappers.toIssueCommentForgejo', () => {
  it('maps a general comment without anchor and without replies', () => {
    expect(toIssueCommentForgejo({ id: 38, body: 'hi <!-- m -->', user: { login: 'bob' } })).toEqual({
      id: 38,
      text: 'hi <!-- m -->',
      authorUsername: 'bob',
      replies: [],
    });
  });
});

const rc = (over: Partial<IForgejoReviewComment> & { id: number }): IForgejoReviewComment => ({
  body: `c${over.id}`,
  user: { login: 'alice' },
  path: 'app.ts',
  position: 3,
  original_position: 0,
  pull_request_review_id: 5,
  ...over,
});

describe('forgejo.mappers.toThreadAnchor', () => {
  it('uses the new side and position when position > 0', () => {
    expect(toThreadAnchor(rc({ id: 1, position: 3, original_position: 0 }))).toEqual({
      reviewId: 5,
      path: 'app.ts',
      side: 'new',
      line: 3,
    });
  });

  it('uses the old side and original_position when position is 0', () => {
    expect(toThreadAnchor(rc({ id: 1, position: 0, original_position: 4 }))).toMatchObject({ side: 'old', line: 4 });
  });

  it('falls back to old side, line 0, when both positions are 0 or null (outdated comment)', () => {
    expect(toThreadAnchor(rc({ id: 1, position: 0, original_position: 0 }))).toMatchObject({ side: 'old', line: 0 });
    expect(toThreadAnchor(rc({ id: 1, position: null, original_position: null }))).toMatchObject({
      side: 'old',
      line: 0,
    });
  });
});

describe('forgejo.mappers.groupReviewComments', () => {
  it('groups comments of the same review, path, side and line into one thread; lowest id is the parent', () => {
    const { comments } = groupReviewComments([
      rc({ id: 39, body: 'reply', user: { login: 'carrot' } }),
      rc({ id: 30, body: 'parent' }),
    ]);
    expect(comments).toEqual([
      {
        id: 30,
        text: 'parent',
        authorUsername: 'alice',
        anchor: { path: 'app.ts', line: 3 },
        replies: [{ id: 39, text: 'reply', authorUsername: 'carrot' }],
      },
    ]);
  });

  it('keeps comments on the same path and line in different reviews as separate threads', () => {
    const { comments } = groupReviewComments([
      rc({ id: 30, pull_request_review_id: 5 }),
      rc({ id: 32, pull_request_review_id: 6 }),
    ]);
    expect(comments.map((c) => c.id)).toEqual([30, 32]);
    expect(comments.every((c) => c.replies.length === 0)).toBe(true);
  });

  it('keeps the old side and the new side of the same line number as separate threads', () => {
    const { comments } = groupReviewComments([
      rc({ id: 30, position: 3, original_position: 0 }),
      rc({ id: 34, position: 0, original_position: 3 }),
    ]);
    expect(comments).toHaveLength(2);
  });

  it('records an anchor for every comment id, parents and replies', () => {
    const { anchors } = groupReviewComments([
      rc({ id: 30 }),
      rc({ id: 39 }),
      rc({ id: 34, position: 0, original_position: 3 }),
    ]);
    expect(anchors.get(30)).toEqual({ reviewId: 5, path: 'app.ts', side: 'new', line: 3 });
    expect(anchors.get(39)).toEqual({ reviewId: 5, path: 'app.ts', side: 'new', line: 3 });
    expect(anchors.get(34)).toEqual({ reviewId: 5, path: 'app.ts', side: 'old', line: 3 });
  });

  it('does not crash on a deleted user or an outdated comment', () => {
    const { comments } = groupReviewComments([rc({ id: 40, user: null, position: 0, original_position: 0 })]);
    expect(comments).toEqual([
      { id: 40, text: 'c40', authorUsername: '', anchor: { path: 'app.ts', line: 0 }, replies: [] },
    ]);
  });
});

describe('forgejo.mappers.toReviewPositions', () => {
  it('puts the line on the matching side and 0 on the other', () => {
    expect(toReviewPositions('new', 12)).toEqual({ new_position: 12, old_position: 0 });
    expect(toReviewPositions('old', 12)).toEqual({ new_position: 0, old_position: 12 });
  });
});

describe('forgejo.mappers.rewriteSuggestionFence', () => {
  it('replaces the first suggestion fence with a labelled plain fence', () => {
    const text = '**Concern** typo.\n\n```suggestion\nconst a = 1; // the value\n```';
    expect(rewriteSuggestionFence(text)).toBe(
      '**Concern** typo.\n\n**Suggested change** (apply by hand):\n\n```\nconst a = 1; // the value\n```',
    );
  });

  it('leaves text without a suggestion fence unchanged', () => {
    expect(rewriteSuggestionFence('plain\n```ts\nx\n```')).toBe('plain\n```ts\nx\n```');
  });
});

describe('forgejo.mappers.quoteReply', () => {
  it('quotes the first line of the parent with its author in bold, then the text', () => {
    expect(quoteReply({ text: 'see this\nmore', authorUsername: 'alice' }, 'On it')).toBe(
      '> **alice**: see this\n\nOn it',
    );
  });

  it('cuts the quoted line at 200 characters', () => {
    const out = quoteReply({ text: 'x'.repeat(300), authorUsername: 'alice' }, 'ok');
    expect(out).toBe(`> **alice**: ${'x'.repeat(200)}\n\nok`);
  });

  it('omits the author for a deleted user and returns the bare text without a parent', () => {
    expect(quoteReply({ text: 'hi', authorUsername: '' }, 'ok')).toBe('> hi\n\nok');
    expect(quoteReply(undefined, 'ok')).toBe('ok');
  });

  it('neutralizes mentions: no bot mention and no @author in the quote', () => {
    const out = quoteReply({ text: '@carrot fix this', authorUsername: 'alice' }, 'On it');
    expect(isBotMention(out, 'carrot')).toBe(false);
    expect(out).not.toContain('@alice');
    expect(out).not.toContain('@carrot');
    expect(out).toBe('> **alice**: @\u200bcarrot fix this\n\nOn it');
  });

  it('neutralizes "@agent carrot" too', () => {
    const out = quoteReply({ text: 'hey @Agent Carrot, look', authorUsername: 'alice' }, 'ok');
    expect(isBotMention(out, 'carrot')).toBe(false);
  });

  it('strips the carriage return of a CRLF first line', () => {
    expect(quoteReply({ text: 'help\r\nmore', authorUsername: 'alice' }, 'ok')).toBe('> **alice**: help\n\nok');
  });
});
