// test/provider/forgejo/forgejo.client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import LogSink from '@chax-at/log-sink';
import { ForgejoProvider } from '../../../src/provider/forgejo/forgejo.client';
import { GitProviderAuthError } from '../../../src/provider/provider';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const API = 'https://forge.example.com/api/v1';

const okJson = (body: unknown, headers: Record<string, string> = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: new Headers(headers),
});
const failed = (status: number, text = '') => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => text,
  headers: new Headers(),
});
/** Zero-width space the quote puts after every @. */
const Z = '\u200b';
const repo = (owner: string, name: string, archived = false) => ({ name, owner: { login: owner }, archived });

describe('ForgejoProvider — git config and auth', () => {
  beforeEach(() => mockFetch.mockReset());

  it('builds clone and scope URLs from the base URL and uses Bearer for git (no email)', () => {
    const cfg = new ForgejoProvider('https://forge.example.com', 'tok').getGitConfig();
    expect(cfg.cloneUrlFor('chax', 'api')).toBe('https://forge.example.com/chax/api.git');
    expect(cfg.authScopeUrl).toBe('https://forge.example.com/');
    expect(cfg.token).toBe('tok');
    expect(cfg.email).toBeUndefined();
  });

  it('strips trailing slashes and keeps a sub-path', async () => {
    const p = new ForgejoProvider('https://host.example.com/forgejo//', 'tok');
    const cfg = p.getGitConfig();
    expect(cfg.cloneUrlFor('chax', 'api')).toBe('https://host.example.com/forgejo/chax/api.git');
    expect(cfg.authScopeUrl).toBe('https://host.example.com/forgejo/');
    mockFetch.mockResolvedValueOnce(okJson({ default_branch: 'main' }));
    await p.getDefaultBranch('chax', 'api');
    expect(mockFetch.mock.calls[0][0]).toBe('https://host.example.com/forgejo/api/v1/repos/chax/api');
  });

  it('sends the token header on REST calls', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ default_branch: 'main' }));
    await new ForgejoProvider('https://forge.example.com', 'tok').getDefaultBranch('chax', 'api');
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('token tok');
  });
});

describe('ForgejoProvider — discovery', () => {
  let provider: ForgejoProvider;
  beforeEach(() => {
    mockFetch.mockReset();
    provider = new ForgejoProvider('https://forge.example.com', 'tok');
  });

  it('listProjects returns each distinct owner of the visible, non-archived repos', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson([repo('chax', 'api'), repo('chax', 'web'), repo('alice', 'tool'), repo('old', 'gone', true)], {
        'x-total-count': '4',
      }),
    );
    expect(await provider.listProjects()).toEqual([
      { key: 'chax', name: 'chax' },
      { key: 'alice', name: 'alice' },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/user/repos?page=1&limit=50`);
  });

  it('skips pull mirrors in listProjects and listRepos', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson(
        [repo('chax', 'api'), { ...repo('mirrors', 'bb'), mirror: true }, { ...repo('chax', 'copy'), mirror: true }],
        {
          'x-total-count': '3',
        },
      ),
    );
    expect(await provider.listProjects()).toEqual([{ key: 'chax', name: 'chax' }]);
    expect(await provider.listRepos('chax')).toEqual([{ slug: 'api', projectKey: 'chax' }]);
  });

  it('listRepos filters the cached repo list by owner without another HTTP call', async () => {
    mockFetch.mockResolvedValueOnce(okJson([repo('chax', 'api'), repo('alice', 'tool')], { 'x-total-count': '2' }));
    await provider.listProjects();
    expect(await provider.listRepos('chax')).toEqual([{ slug: 'api', projectKey: 'chax' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('listRepos loads the repo list itself when listProjects was not called', async () => {
    mockFetch.mockResolvedValueOnce(okJson([repo('chax', 'api')], { 'x-total-count': '1' }));
    expect(await provider.listRepos('chax')).toEqual([{ slug: 'api', projectKey: 'chax' }]);
  });

  it('pages until X-Total-Count is reached, even when pages are shorter than the limit', async () => {
    const page1 = Array.from({ length: 30 }, (_, i) => repo('chax', `r${i}`));
    const page2 = Array.from({ length: 5 }, (_, i) => repo('chax', `s${i}`));
    mockFetch
      .mockResolvedValueOnce(okJson(page1, { 'x-total-count': '35' }))
      .mockResolvedValueOnce(okJson(page2, { 'x-total-count': '35' }));
    expect(await provider.listRepos('chax')).toHaveLength(35);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe(`${API}/user/repos?page=2&limit=50`);
  });

  it('pages until an empty page when X-Total-Count is missing', async () => {
    mockFetch.mockResolvedValueOnce(okJson([repo('chax', 'api')])).mockResolvedValueOnce(okJson([]));
    expect(await provider.listRepos('chax')).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws GitProviderAuthError on 401 and 403 in a list call', async () => {
    mockFetch.mockResolvedValueOnce(failed(401));
    await expect(provider.listProjects()).rejects.toBeInstanceOf(GitProviderAuthError);
    mockFetch.mockResolvedValueOnce(failed(403));
    await expect(provider.listProjects()).rejects.toBeInstanceOf(GitProviderAuthError);
  });

  it('listBranches returns branch names with paging', async () => {
    mockFetch.mockResolvedValueOnce(okJson([{ name: 'main' }, { name: 'release/1' }], { 'x-total-count': '2' }));
    expect(await provider.listBranches('chax', 'api')).toEqual(['main', 'release/1']);
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/branches?page=1&limit=50`);
  });

  it('getDefaultBranch returns default_branch, or null on error', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ default_branch: 'develop' }));
    expect(await provider.getDefaultBranch('chax', 'api')).toBe('develop');
    mockFetch.mockResolvedValueOnce(failed(404));
    expect(await provider.getDefaultBranch('chax', 'api')).toBeNull();
  });

  it('getBranchLatestCommit encodes each branch segment and keeps the slash', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ name: 'feature/KEY-1 x#2', commit: { id: 'h1' } }));
    expect(await provider.getBranchLatestCommit('chax', 'api', 'feature/KEY-1 x#2')).toBe('h1');
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/branches/feature/KEY-1%20x%232`);
  });

  it('getBranchLatestCommit returns null on error', async () => {
    mockFetch.mockResolvedValueOnce(failed(404));
    expect(await provider.getBranchLatestCommit('chax', 'api', 'nope')).toBeNull();
  });

  it('getLatestCommitTimestampMs reads the newest commit, preferring created over the committer date', async () => {
    mockFetch.mockResolvedValueOnce(okJson([{ sha: 'a', created: '2026-10-01T10:00:00Z' }]));
    expect(await provider.getLatestCommitTimestampMs('chax', 'api')).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(mockFetch.mock.calls[0][0]).toBe(
      `${API}/repos/chax/api/commits?limit=1&stat=false&verification=false&files=false`,
    );
    mockFetch.mockResolvedValueOnce(okJson([{ sha: 'a', commit: { committer: { date: '2026-09-01T00:00:00Z' } } }]));
    expect(await provider.getLatestCommitTimestampMs('chax', 'api')).toBe(Date.parse('2026-09-01T00:00:00Z'));
  });

  it('getLatestCommitTimestampMs returns null for an empty repo, a bad date or an error', async () => {
    mockFetch.mockResolvedValueOnce(okJson([]));
    expect(await provider.getLatestCommitTimestampMs('chax', 'api')).toBeNull();
    mockFetch.mockResolvedValueOnce(okJson([{ sha: 'a', created: 'nope' }]));
    expect(await provider.getLatestCommitTimestampMs('chax', 'api')).toBeNull();
    mockFetch.mockResolvedValueOnce(failed(404));
    expect(await provider.getLatestCommitTimestampMs('chax', 'api')).toBeNull();
  });
});

describe('ForgejoProvider — retries', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
    vi.spyOn(LogSink, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a 5xx and succeeds on the next attempt', async () => {
    const provider = new ForgejoProvider('https://forge.example.com', 'tok');
    mockFetch.mockResolvedValueOnce(failed(502)).mockResolvedValueOnce(okJson({ default_branch: 'main' }));
    const promise = provider.getDefaultBranch('chax', 'api');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe('main');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a network error', async () => {
    const provider = new ForgejoProvider('https://forge.example.com', 'tok');
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okJson({ default_branch: 'main' }));
    const promise = provider.getDefaultBranch('chax', 'api');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe('main');
  });

  it('does not retry a 4xx', async () => {
    const provider = new ForgejoProvider('https://forge.example.com', 'tok');
    mockFetch.mockResolvedValueOnce(failed(404));
    expect(await provider.getDefaultBranch('chax', 'api')).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('waits and retries a 429 in a list call', async () => {
    const provider = new ForgejoProvider('https://forge.example.com', 'tok');
    mockFetch
      .mockResolvedValueOnce(failed(429))
      .mockResolvedValueOnce(okJson([repo('chax', 'api')], { 'x-total-count': '1' }));
    const promise = provider.listProjects();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toEqual([{ key: 'chax', name: 'chax' }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

const wirePr = (number: number, state: 'open' | 'closed' = 'open') => ({
  number,
  title: `PR ${number}`,
  body: 'b',
  state,
  draft: false,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T11:00:00Z',
  head: { ref: 'feature/x', sha: 'abc' },
  base: { ref: 'main' },
  user: { login: 'alice' },
  requested_reviewers: [],
});

describe('ForgejoProvider — pull requests', () => {
  let provider: ForgejoProvider;
  beforeEach(() => {
    mockFetch.mockReset();
    provider = new ForgejoProvider('https://forge.example.com', 'tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('getOpenPullRequests lists open PRs with paging and maps them', async () => {
    mockFetch.mockResolvedValueOnce(okJson([wirePr(1), wirePr(2)], { 'x-total-count': '2' }));
    const prs = await provider.getOpenPullRequests('chax', 'api');
    expect(prs.map((p) => p.id)).toEqual([1, 2]);
    expect(prs[0].sourceBranch).toBe('feature/x');
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/pulls?state=open&page=1&limit=50`);
  });

  it('getPullRequest maps one PR, or returns null on error', async () => {
    mockFetch.mockResolvedValueOnce(okJson(wirePr(7)));
    expect((await provider.getPullRequest('chax', 'api', 7))?.id).toBe(7);
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/pulls/7`);
    vi.spyOn(LogSink, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(failed(404));
    expect(await provider.getPullRequest('chax', 'api', 8)).toBeNull();
  });

  it('isPrOpen is true only for an open PR', async () => {
    mockFetch.mockResolvedValueOnce(okJson(wirePr(7, 'open')));
    expect(await provider.isPrOpen('chax', 'api', 7)).toBe(true);
    mockFetch.mockResolvedValueOnce(okJson(wirePr(7, 'closed')));
    expect(await provider.isPrOpen('chax', 'api', 7)).toBe(false);
  });

  it('createFixPr posts title, body, head and base and returns the PR number', async () => {
    mockFetch
      .mockResolvedValueOnce(okJson({ number: 12 }))
      .mockResolvedValueOnce(okJson({ default_delete_branch_after_merge: true }));
    const id = await provider.createFixPr('chax', 'api', 'fix: x', 'desc', 'carrot/fix-1', 'feature/x');
    expect(id).toBe(12);
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/pulls`);
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      title: 'fix: x',
      body: 'desc',
      head: 'carrot/fix-1',
      base: 'feature/x',
    });
  });

  it('createFixPr throws with the response text on failure', async () => {
    mockFetch.mockResolvedValueOnce(failed(409, 'pull request already exists'));
    await expect(provider.createFixPr('chax', 'api', 't', 'd', 'a', 'b')).rejects.toThrow(
      'Failed to create PR: 409 pull request already exists',
    );
  });

  it('warns once per repo when the repo does not delete merged branches', async () => {
    const warn = vi.spyOn(LogSink, 'warn').mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce(okJson({ number: 1 }))
      .mockResolvedValueOnce(okJson({ default_delete_branch_after_merge: false }))
      .mockResolvedValueOnce(okJson({ number: 2 }));
    await provider.createFixPr('chax', 'api', 't', 'd', 'a', 'b');
    await provider.createFixPr('chax', 'api', 't', 'd', 'a', 'b');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      'Forgejo repo chax/api: "Delete pull request branch after merge by default" is off — carrot branches will stay after merge',
    );
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not warn when the repo deletes merged branches, or when the repo read fails', async () => {
    const warn = vi.spyOn(LogSink, 'warn').mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce(okJson({ number: 1 }))
      .mockResolvedValueOnce(okJson({ default_delete_branch_after_merge: true }))
      .mockResolvedValueOnce(okJson({ number: 2 }))
      .mockResolvedValueOnce(failed(404));
    await provider.createFixPr('chax', 'api', 't', 'd', 'a', 'b');
    await provider.createFixPr('chax', 'web', 't', 'd', 'a', 'b');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ForgejoProvider — build statuses and files', () => {
  let provider: ForgejoProvider;
  beforeEach(() => {
    mockFetch.mockReset();
    provider = new ForgejoProvider('https://forge.example.com', 'tok');
  });

  it('getBuildStatuses lists and maps commit statuses', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson([{ status: 'failure', target_url: 'https://ci/2', context: 'ci/test' }], { 'x-total-count': '1' }),
    );
    expect(await provider.getBuildStatuses('chax', 'api', 'abc')).toEqual([
      { state: 'failed', url: 'https://ci/2', key: 'ci/test' },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/commits/abc/statuses?page=1&limit=50`);
  });

  it('getFileContent reads the raw file at a ref and encodes each path segment', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{ "x": 1 }', headers: new Headers() });
    expect(await provider.getFileContent('chax', 'api', 'docs/a b#1.md', { at: 'feature/x' })).toBe('{ "x": 1 }');
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/raw/docs/a%20b%231.md?ref=feature%2Fx`);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('token tok');
  });

  it('getFileContent without a ref reads the default branch (no ref parameter)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'x', headers: new Headers() });
    await provider.getFileContent('chax', 'api', '.carrot.jsonc', { quiet: true });
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/raw/.carrot.jsonc`);
  });

  it('getFileContent returns null for a missing file', async () => {
    mockFetch.mockResolvedValueOnce(failed(404, 'not found'));
    expect(await provider.getFileContent('chax', 'api', '.carrot.jsonc', { quiet: true })).toBeNull();
  });
});

/** Queue the requests getComments makes for one PR: issue comments, timeline, reviews, then each review's comments. */
const queuePrComments = (opts: {
  issue: unknown[];
  timeline?: unknown[];
  reviews: Array<{ id: number; comments_count?: number }>;
  reviewComments: Record<number, unknown[]>;
}) => {
  const timeline = opts.timeline ?? [];
  mockFetch.mockResolvedValueOnce(okJson(opts.issue));
  mockFetch.mockResolvedValueOnce(okJson(timeline, { 'x-total-count': String(timeline.length) }));
  mockFetch.mockResolvedValueOnce(okJson(opts.reviews, { 'x-total-count': String(opts.reviews.length) }));
  for (const r of opts.reviews) {
    if (r.comments_count === 0) continue;
    mockFetch.mockResolvedValueOnce(okJson(opts.reviewComments[r.id] ?? []));
  }
};

const codeComment = (id: number, reviewId: number, over: Record<string, unknown> = {}) => ({
  id,
  body: `code ${id}`,
  user: { login: 'alice' },
  path: 'app.ts',
  position: 3,
  original_position: 0,
  pull_request_review_id: reviewId,
  ...over,
});

describe('ForgejoProvider — reading comments', () => {
  let provider: ForgejoProvider;
  beforeEach(() => {
    mockFetch.mockReset();
    provider = new ForgejoProvider('https://forge.example.com', 'tok');
  });

  it('getComments merges general comments and review threads, sorted by id', async () => {
    queuePrComments({
      issue: [{ id: 38, body: 'general <!-- carrot-review commit=abc -->', user: { login: 'carrot' } }],
      reviews: [
        { id: 5, comments_count: 2 },
        { id: 9, comments_count: 0 },
        { id: 6, comments_count: 1 },
      ],
      reviewComments: {
        5: [codeComment(30, 5), codeComment(39, 5, { user: { login: 'carrot' } })],
        6: [codeComment(32, 6)],
      },
    });
    const comments = await provider.getComments('chax', 'api', 1);
    expect(comments.map((c) => c.id)).toEqual([30, 32, 38]);
    expect(comments[0].replies).toEqual([{ id: 39, text: 'code 39', authorUsername: 'carrot' }]);
    expect(comments[0].anchor).toEqual({ path: 'app.ts', line: 3 });
    expect(comments[2]).toEqual({
      id: 38,
      text: 'general <!-- carrot-review commit=abc -->',
      authorUsername: 'carrot',
      replies: [],
    });
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual([
      `${API}/repos/chax/api/issues/1/comments`,
      `${API}/repos/chax/api/issues/1/timeline?page=1&limit=50`,
      `${API}/repos/chax/api/pulls/1/reviews?page=1&limit=50`,
      `${API}/repos/chax/api/pulls/1/reviews/5/comments`,
      `${API}/repos/chax/api/pulls/1/reviews/6/comments`,
    ]);
  });

  it('getActivities wraps every comment with id = comment id', async () => {
    queuePrComments({ issue: [{ id: 38, body: 'g', user: { login: 'bob' } }], reviews: [], reviewComments: {} });
    const activities = await provider.getActivities('chax', 'api', 1);
    expect(activities).toEqual([{ id: 38, comment: { id: 38, text: 'g', authorUsername: 'bob', replies: [] } }]);
  });

  it('getActivities gives a code thread the id of its review submit entry when that is higher', async () => {
    queuePrComments({
      issue: [{ id: 38, body: 'g', user: { login: 'bob' } }],
      timeline: [
        { id: 31, type: 'review', review_id: 5 },
        { id: 50, type: 'review', review_id: 5 },
      ],
      reviews: [{ id: 5, comments_count: 2 }],
      reviewComments: { 5: [codeComment(30, 5), codeComment(39, 5)] },
    });
    const activities = await provider.getActivities('chax', 'api', 1);
    expect(activities.map((a) => [a.id, a.comment.id])).toEqual([
      [50, 30],
      [38, 38],
    ]);
  });

  it('getActivities keeps the own id without a review entry and ignores other entries', async () => {
    queuePrComments({
      issue: [{ id: 38, body: 'g', user: { login: 'bob' } }],
      timeline: [
        { id: 90, type: 'comment', review_id: 5 },
        { id: 91, type: 'review', review_id: null },
        { id: 92, type: 'review' },
        { id: 93, type: 'review', review_id: 7 },
      ],
      reviews: [
        { id: 5, comments_count: 1 },
        { id: 6, comments_count: 1 },
      ],
      reviewComments: { 5: [codeComment(30, 5)], 6: [codeComment(32, 6)] },
    });
    const activities = await provider.getActivities('chax', 'api', 1);
    expect(activities.map((a) => a.id)).toEqual([30, 32, 38]);
  });

  it('getComment returns a thread parent with its replies', async () => {
    queuePrComments({
      issue: [],
      reviews: [{ id: 5, comments_count: 2 }],
      reviewComments: { 5: [codeComment(30, 5), codeComment(39, 5)] },
    });
    const c = await provider.getComment('chax', 'api', 1, 30);
    expect(c?.replies.map((r) => r.id)).toEqual([39]);
  });

  it('getComment returns a reply alone, with no replies (never the whole thread)', async () => {
    queuePrComments({
      issue: [],
      reviews: [{ id: 5, comments_count: 3 }],
      reviewComments: {
        5: [codeComment(30, 5), codeComment(39, 5), codeComment(41, 5, { user: { login: 'carrot' } })],
      },
    });
    expect(await provider.getComment('chax', 'api', 1, 39)).toEqual({
      id: 39,
      text: 'code 39',
      authorUsername: 'alice',
      replies: [],
    });
  });

  it('getComment returns null for an unknown id or when loading fails', async () => {
    queuePrComments({ issue: [], reviews: [], reviewComments: {} });
    expect(await provider.getComment('chax', 'api', 1, 999)).toBeNull();
    mockFetch.mockResolvedValueOnce(failed(404));
    expect(await provider.getComment('chax', 'api', 1, 30)).toBeNull();
  });
});

describe('ForgejoProvider — writing comments', () => {
  let provider: ForgejoProvider;
  beforeEach(() => {
    mockFetch.mockReset();
    provider = new ForgejoProvider('https://forge.example.com', 'tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('postInlineComment creates a COMMENT review with the line on the new side for added and context lines', async () => {
    mockFetch.mockResolvedValue(okJson({ id: 5 }));
    await provider.postInlineComment('chax', 'api', 1, { text: 'note', path: 'a.ts', line: 12, lineKind: 'added' });
    await provider.postInlineComment('chax', 'api', 1, { text: 'ctx', path: 'a.ts', line: 4, lineKind: 'context' });
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/pulls/1/reviews`);
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      event: 'COMMENT',
      body: '',
      comments: [{ path: 'a.ts', body: 'note', new_position: 12, old_position: 0 }],
    });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).comments[0]).toMatchObject({ new_position: 4, old_position: 0 });
  });

  it('postInlineComment puts a removed line on the old side and ignores oldPath', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ id: 5 }));
    await provider.postInlineComment('chax', 'api', 1, {
      text: 'gone',
      path: 'b.ts',
      oldPath: 'a.ts',
      line: 3,
      lineKind: 'removed',
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).comments[0]).toEqual({
      path: 'b.ts',
      body: 'gone',
      new_position: 0,
      old_position: 3,
    });
  });

  it('postInlineComment rewrites the suggestion fence only when a suggestion is attached', async () => {
    mockFetch.mockResolvedValue(okJson({ id: 5 }));
    const text = '**Concern** typo.\n\n```suggestion\nfixed\n```';
    await provider.postInlineComment('chax', 'api', 1, {
      text,
      path: 'a.ts',
      line: 3,
      lineKind: 'added',
      suggestion: { replacement: 'fixed', startLine: 3, endLine: 3 },
    });
    await provider.postInlineComment('chax', 'api', 1, { text, path: 'a.ts', line: 3, lineKind: 'added' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).comments[0].body).toBe(
      '**Concern** typo.\n\n**Suggested change** (apply by hand):\n\n```\nfixed\n```',
    );
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).comments[0].body).toBe(text);
  });

  it('postInlineComment logs and returns on a 4xx (best effort, no throw, no retry)', async () => {
    const error = vi.spyOn(LogSink, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(failed(422, 'line not in diff'));
    await provider.postInlineComment('chax', 'api', 1, { text: 'n', path: 'a.ts', line: 99, lineKind: 'context' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('422');
  });

  it('postGeneralComment posts to the issue comments and returns the new id', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ id: 77 }));
    expect(await provider.postGeneralComment('chax', 'api', 1, 'hello')).toBe(77);
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/issues/1/comments`);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ body: 'hello' });
  });

  it('postGeneralComment returns null on failure', async () => {
    vi.spyOn(LogSink, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(failed(403, 'forbidden'));
    expect(await provider.postGeneralComment('chax', 'api', 1, 'hello')).toBeNull();
  });

  it('updateComment patches the comment body', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ id: 77 }));
    await provider.updateComment('chax', 'api', 1, 77, 'new text');
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/issues/comments/77`);
    expect(mockFetch.mock.calls[0][1].method).toBe('PATCH');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ body: 'new text' });
  });
});

describe('ForgejoProvider — replies', () => {
  let provider: ForgejoProvider;
  beforeEach(() => {
    mockFetch.mockReset();
    provider = new ForgejoProvider('https://forge.example.com', 'tok');
    vi.spyOn(LogSink, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const loadThreads = async () => {
    queuePrComments({
      issue: [{ id: 38, body: '@carrot explain\nplease', user: { login: 'bob' } }],
      reviews: [{ id: 5, comments_count: 3 }],
      reviewComments: {
        5: [
          codeComment(30, 5),
          codeComment(39, 5, { body: '@carrot fix this' }),
          codeComment(34, 5, { position: 0, original_position: 3 }),
        ],
      },
    });
    await provider.getComments('chax', 'api', 1);
    mockFetch.mockReset();
  };

  it('replies to a new-side thread parent inside its review', async () => {
    await loadThreads();
    mockFetch.mockResolvedValueOnce(okJson({ id: 50 }));
    await provider.replyToComment('chax', 'api', 1, 30, 'On it');
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/pulls/1/reviews/5/comments`);
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      path: 'app.ts',
      body: 'On it',
      new_position: 3,
      old_position: 0,
    });
  });

  it('replies to a reply inside a thread at the same review and line', async () => {
    await loadThreads();
    mockFetch.mockResolvedValueOnce(okJson({ id: 51 }));
    await provider.replyToComment('chax', 'api', 1, 39, 'Done');
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/pulls/1/reviews/5/comments`);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ new_position: 3, old_position: 0 });
  });

  it('replies to an old-side thread with old_position', async () => {
    await loadThreads();
    mockFetch.mockResolvedValueOnce(okJson({ id: 52 }));
    await provider.replyToComment('chax', 'api', 1, 34, 'ok');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ new_position: 0, old_position: 3 });
  });

  it('replies to a general comment with a quoted general comment', async () => {
    await loadThreads();
    mockFetch.mockResolvedValueOnce(okJson({ id: 53 }));
    await provider.replyToComment('chax', 'api', 1, 38, 'Here is why');
    expect(mockFetch.mock.calls[0][0]).toBe(`${API}/repos/chax/api/issues/1/comments`);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      body: `> **bob**: @${Z}carrot explain\n\nHere is why`,
    });
  });

  it('falls back to a quoted general comment when the reply into the review fails', async () => {
    await loadThreads();
    mockFetch.mockResolvedValueOnce(failed(422, 'review is stale')).mockResolvedValueOnce(okJson({ id: 54 }));
    await provider.replyToComment('chax', 'api', 1, 39, 'Done');
    expect(mockFetch.mock.calls[1][0]).toBe(`${API}/repos/chax/api/issues/1/comments`);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ body: `> **alice**: @${Z}carrot fix this\n\nDone` });
  });

  it('loads the comments first when the parent is not in the index yet', async () => {
    queuePrComments({
      issue: [],
      reviews: [{ id: 5, comments_count: 1 }],
      reviewComments: { 5: [codeComment(30, 5)] },
    });
    mockFetch.mockResolvedValueOnce(okJson({ id: 55 }));
    await provider.replyToComment('chax', 'api', 1, 30, 'On it');
    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(mockFetch.mock.calls[4][0]).toBe(`${API}/repos/chax/api/pulls/1/reviews/5/comments`);
    expect(mockFetch.mock.calls[4][1].method).toBe('POST');
  });

  it('posts the bare text as a general comment when the comments can not be loaded', async () => {
    mockFetch.mockResolvedValueOnce(failed(404)).mockResolvedValueOnce(okJson({ id: 56 }));
    await provider.replyToComment('chax', 'api', 1, 30, 'On it');
    expect(mockFetch.mock.calls[1][0]).toBe(`${API}/repos/chax/api/issues/1/comments`);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ body: 'On it' });
  });

  it('omits the author in the quote when the parent author was deleted', async () => {
    queuePrComments({ issue: [{ id: 38, body: 'help', user: null }], reviews: [], reviewComments: {} });
    mockFetch.mockResolvedValueOnce(okJson({ id: 57 }));
    await provider.replyToComment('chax', 'api', 1, 38, 'ok');
    expect(JSON.parse(mockFetch.mock.calls[3][1].body)).toEqual({ body: '> help\n\nok' });
  });
});
