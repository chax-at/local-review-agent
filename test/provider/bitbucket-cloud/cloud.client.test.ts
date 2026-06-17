// test/provider/bitbucket-cloud/cloud.client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketCloudProvider } from '../../../src/provider/bitbucket-cloud/cloud.client';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('BitbucketCloudProvider', () => {
  let provider: BitbucketCloudProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new BitbucketCloudProvider('myws', 'tok');
  });

  it('getGitConfig returns Cloud clone URL and bearer scope', () => {
    const cfg = provider.getGitConfig();
    expect(cfg.cloneUrlFor('myws', 'r')).toBe('https://bitbucket.org/myws/r.git');
    expect(cfg.authScopeUrl).toBe('https://bitbucket.org/');
    expect(cfg.token).toBe('tok');
  });

  it('getGitConfig uses Cloud static git-auth username when Basic mode is active', () => {
    // REST API takes the Atlassian email as Basic username, but git-over-HTTPS
    // takes the static `x-bitbucket-api-token-auth` (per Atlassian docs).
    const p = new BitbucketCloudProvider('myws', 'tok', 'user@example.com');
    expect(p.getGitConfig().email).toBe('x-bitbucket-api-token-auth');
  });

  it('getGitConfig leaves email undefined when no Basic mode (Bearer path)', () => {
    const p = new BitbucketCloudProvider('myws', 'tok');
    expect(p.getGitConfig().email).toBe(undefined);
  });

  it('uses Basic auth when an email is provided', async () => {
    const basicProvider = new BitbucketCloudProvider('ws', 'tok', 'user@example.com');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ values: [] }),
    });
    await basicProvider.listRepos('ws');
    const sentAuth = mockFetch.mock.calls[0][1].headers.Authorization;
    expect(sentAuth.startsWith('Basic ')).toBe(true);
    const decoded = Buffer.from(sentAuth.slice(6), 'base64').toString('utf8');
    expect(decoded).toBe('user@example.com:tok');
  });

  it('uses Bearer auth by default (no email)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ values: [] }),
    });
    await provider.listRepos('myws');
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('synthesises listProjects to a single workspace entry', async () => {
    const projects = await provider.listProjects();
    expect(projects).toEqual([{ key: 'myws', name: 'myws' }]);
  });
});

describe('BitbucketCloudProvider — discovery and PRs', () => {
  let provider: BitbucketCloudProvider;
  beforeEach(() => {
    mockFetch.mockReset();
    provider = new BitbucketCloudProvider('ws', 'tok');
  });

  it('listRepos paginates and maps to neutral', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          values: [{ slug: 'api', full_name: 'ws/api' }],
          next: 'https://api.bitbucket.org/2.0/repositories/ws?page=2',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ values: [{ slug: 'web', full_name: 'ws/web' }] }),
      });

    const repos = await provider.listRepos('ws');
    expect(repos).toEqual([
      { slug: 'api', projectKey: 'ws' },
      { slug: 'web', projectKey: 'ws' },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.bitbucket.org/2.0/repositories/ws');
  });

  it('listBranches returns branch names', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        values: [{ name: 'main', target: { hash: 'h1' } }, { name: 'release/1', target: { hash: 'h2' } }],
      }),
    });
    const branches = await provider.listBranches('ws', 'api');
    expect(branches).toEqual(['main', 'release/1']);
  });

  it('getOpenPullRequests filters by state=OPEN', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        values: [
          {
            id: 1, title: 't', state: 'OPEN', draft: false,
            created_on: '2026-01-01T00:00:00Z', updated_on: '2026-01-02T00:00:00Z',
            source: { branch: { name: 'feat' }, commit: { hash: 'a' } },
            destination: { branch: { name: 'main' } },
            author: { account_id: 'u' },
          },
        ],
      }),
    });
    const prs = await provider.getOpenPullRequests('ws', 'api');
    expect(prs).toHaveLength(1);
    expect(prs[0].isOpen).toBe(true);
    expect(prs[0].sourceCommit).toBe('a');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/pullrequests');
    expect(url).toContain('state%3D%22OPEN%22');
  });

  it('getPullRequest returns neutral PR or null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 9, title: 't', state: 'OPEN', draft: false,
        created_on: '2026-01-01T00:00:00Z', updated_on: '2026-01-01T00:00:00Z',
        source: { branch: { name: 'a' }, commit: { hash: 'h' } },
        destination: { branch: { name: 'b' } },
        author: { account_id: 'u' },
      }),
    });
    const pr = await provider.getPullRequest('ws', 'api', 9);
    expect(pr?.id).toBe(9);
  });

  it('isPrOpen reflects neutral isOpen', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 9, title: 't', state: 'MERGED', draft: false,
        created_on: '2026-01-01T00:00:00Z', updated_on: '2026-01-01T00:00:00Z',
        source: { branch: { name: 'a' }, commit: { hash: 'h' } },
        destination: { branch: { name: 'b' } },
        author: { account_id: 'u' },
      }),
    });
    expect(await provider.isPrOpen('ws', 'api', 9)).toBe(false);
  });

  it('getLatestCommitTimestampMs parses ISO date', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ values: [{ hash: 'h', date: '2026-05-15T08:30:00Z' }] }),
    });
    const ts = await provider.getLatestCommitTimestampMs('ws', 'api');
    expect(ts).toBe(Date.parse('2026-05-15T08:30:00Z'));
  });

  it('getBranchLatestCommit returns hash', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: 'main', target: { hash: 'abc' } }),
    });
    const hash = await provider.getBranchLatestCommit('ws', 'api', 'main');
    expect(hash).toBe('abc');
  });

  it('throws GitProviderAuthError on 401', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    await expect(provider.listRepos('ws')).rejects.toMatchObject({ name: 'GitProviderAuthError' });
  });
});

describe('BitbucketCloudProvider — comments', () => {
  let provider: BitbucketCloudProvider;
  beforeEach(() => {
    mockFetch.mockReset();
    provider = new BitbucketCloudProvider('ws', 'tok');
  });

  it('getComments paginates and rebuilds reply tree', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        values: [
          { id: 1, content: { raw: 'parent' }, user: { account_id: 'a' }, created_on: '' },
          { id: 2, content: { raw: 'child' }, user: { account_id: 'b' }, parent: { id: 1 }, created_on: '' },
          { id: 3, content: { raw: 'unrel' }, user: { account_id: 'c' }, created_on: '' },
        ],
      }),
    });
    const comments = await provider.getComments('ws', 'r', 1);
    expect(comments).toHaveLength(3);
    const parent = comments.find((c) => c.id === 1)!;
    expect(parent.replies).toEqual([{ id: 2, text: 'child', authorUsername: 'b' }]);
  });

  it('getActivities synthesises id = comment.id and embeds the neutral comment', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        values: [
          { id: 10, content: { raw: 't' }, user: { account_id: 'a' }, created_on: '' },
        ],
      }),
    });
    const activities = await provider.getActivities('ws', 'r', 1);
    expect(activities).toEqual([
      { id: 10, comment: { id: 10, text: 't', authorUsername: 'a', anchor: undefined, replies: [] } },
    ]);
  });

  it('postInlineComment writes inline.to for added/context, inline.from for removed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await provider.postInlineComment('ws', 'r', 1, {
      text: 'note',
      path: 'src/x.ts',
      line: 5,
      lineKind: 'added',
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ content: { raw: 'note' }, inline: { path: 'src/x.ts', to: 5 } });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await provider.postInlineComment('ws', 'r', 1, {
      text: 'note2',
      path: 'src/x.ts',
      line: 8,
      lineKind: 'removed',
    });
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body2).toEqual({ content: { raw: 'note2' }, inline: { path: 'src/x.ts', from: 8 } });
  });

  it('postGeneralComment returns new comment id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 42 }) });
    const id = await provider.postGeneralComment('ws', 'r', 1, 'general note');
    expect(id).toBe(42);
  });

  it('replyToComment includes parent.id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await provider.replyToComment('ws', 'r', 1, 99, 'reply text');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ content: { raw: 'reply text' }, parent: { id: 99 } });
  });

  it('updateComment PUTs new content (no version)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await provider.updateComment('ws', 'r', 1, 7, 'new text');
    expect(mockFetch.mock.calls[0][1].method).toBe('PUT');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ content: { raw: 'new text' } });
  });
});

describe('BitbucketCloudProvider — PR create, builds, files', () => {
  let provider: BitbucketCloudProvider;
  beforeEach(() => {
    mockFetch.mockReset();
    provider = new BitbucketCloudProvider('ws', 'tok');
  });

  it('createFixPr posts close_source_branch=true and returns id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 77 }) });
    const id = await provider.createFixPr('ws', 'r', 'title', 'desc', 'feat', 'main');
    expect(id).toBe(77);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      title: 'title',
      description: 'desc',
      source: { branch: { name: 'feat' } },
      destination: { branch: { name: 'main' } },
      close_source_branch: true,
    });
  });

  it('getBuildStatuses paginates and lowercases state', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        values: [
          { key: 'plan-1', state: 'FAILED', url: 'https://bamboo.example.com/browse/PLAN-NN-1' },
          { key: 'plan-2', state: 'SUCCESSFUL', url: 'https://bamboo.example.com/browse/PLAN-NN-2' },
        ],
      }),
    });
    const statuses = await provider.getBuildStatuses('ws', 'r', 'abc123');
    expect(statuses.map((s) => s.state)).toEqual(['failed', 'successful']);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/ws/r/commit/abc123/statuses',
    );
  });

  it('getFileContent returns raw text body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'hello\nworld',
    });
    const content = await provider.getFileContent('ws', 'r', 'README.md', { at: 'main', quiet: true });
    expect(content).toBe('hello\nworld');
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/ws/r/src/main/README.md',
    );
  });

  it('getFileContent returns null for 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const content = await provider.getFileContent('ws', 'r', 'missing.md', { at: 'main', quiet: true });
    expect(content).toBe(null);
  });
});
