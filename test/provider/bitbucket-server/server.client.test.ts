import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketServerProvider } from '../../../src/provider/bitbucket-server/server.client';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('BitbucketServerProvider', () => {
  let provider: BitbucketServerProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new BitbucketServerProvider('https://bitbucket.example.com', 'test-token');
  });

  it('paginates open PRs and returns them in neutral shape', async () => {
    const wirePr = (id: number, slug: string) => ({
      id,
      title: `PR ${id}`,
      state: 'OPEN',
      open: true,
      draft: false,
      fromRef: {
        id: 'refs/heads/feat',
        displayId: 'feat',
        latestCommit: `c${id}`,
        repository: { slug, project: { key: 'P' } },
      },
      toRef: {
        id: 'refs/heads/main',
        displayId: 'main',
        latestCommit: 'main-tip',
        repository: { slug, project: { key: 'P' } },
      },
      author: { user: { slug: 'dev' } },
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          values: [wirePr(1, 'r')],
          isLastPage: false,
          nextPageStart: 1,
          size: 1,
          limit: 1,
          start: 0,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          values: [wirePr(2, 'r')],
          isLastPage: true,
          size: 1,
          limit: 1,
          start: 1,
        }),
      });

    const prs = await provider.getOpenPullRequests('P', 'r');
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({
      id: 1,
      sourceCommit: 'c1',
      sourceBranch: 'feat',
      targetBranch: 'main',
      isOpen: true,
    });
    expect(prs[1]).toMatchObject({ id: 2, sourceCommit: 'c2' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('sends Authorization: Bearer header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ values: [], isLastPage: true, size: 0, limit: 100, start: 0 }),
    });
    await provider.getOpenPullRequests('P', 'r');
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
  });

  it('throws GitProviderAuthError on 401 / 403', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    await expect(provider.getOpenPullRequests('P', 'r')).rejects.toMatchObject({
      name: 'GitProviderAuthError',
    });
  });

  it('posts inline comments with DC-shaped anchor built from neutral input', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await provider.postInlineComment('P', 'r', 7, {
      text: 'note',
      path: 'src/x.ts',
      line: 5,
      lineKind: 'added',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      text: 'note',
      anchor: { path: 'src/x.ts', line: 5, lineType: 'ADDED' },
    });
  });

  it('getGitConfig returns clone URL and bearer scope', () => {
    const cfg = provider.getGitConfig();
    expect(cfg.cloneUrlFor('P', 'r')).toBe('https://bitbucket.example.com/scm/P/r.git');
    expect(cfg.authScopeUrl).toBe('https://bitbucket.example.com/');
    expect(cfg.token).toBe('test-token');
  });
});
