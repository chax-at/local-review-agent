import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  it('getDefaultBranch reads /branches/default displayId', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ displayId: 'develop' }) });
    expect(await provider.getDefaultBranch('P', 'r')).toBe('develop');
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://bitbucket.example.com/rest/api/1.0/projects/P/repos/r/branches/default',
    );
  });

  it('getDefaultBranch returns null on a non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' });
    expect(await provider.getDefaultBranch('P', 'r')).toBeNull();
  });

  it('getFileContent reads every /browse page and joins the lines in order', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          lines: [{ text: 'line 1' }, { text: 'line 2' }],
          start: 0,
          isLastPage: false,
          nextPageStart: 2,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lines: [{ text: 'line 3' }], start: 2, isLastPage: true }),
      });

    expect(await provider.getFileContent('P', 'r', 'src/big.ts', { at: 'main', quiet: true })).toBe(
      'line 1\nline 2\nline 3',
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://bitbucket.example.com/rest/api/1.0/projects/P/repos/r/browse/src/big.ts?at=main&start=0',
    );
    expect(mockFetch.mock.calls[1][0]).toBe(
      'https://bitbucket.example.com/rest/api/1.0/projects/P/repos/r/browse/src/big.ts?at=main&start=2',
    );
  });

  it('getFileContent returns null when a later /browse page fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ lines: [{ text: 'line 1' }], start: 0, isLastPage: false, nextPageStart: 1 }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' });

    expect(await provider.getFileContent('P', 'r', 'src/big.ts', { quiet: true })).toBeNull();
  });

  it('getFileContent returns null when a page is not the last one but gives no next start', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ lines: [{ text: 'line 1' }], isLastPage: false }),
    });

    expect(await provider.getFileContent('P', 'r', 'src/big.ts', { quiet: true })).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('getFileContent encodes each segment of the file path', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ lines: [{ text: 'x' }], isLastPage: true }) });

    expect(await provider.getFileContent('P', 'r', 'docs/a b#1.md', { at: 'feature/x', quiet: true })).toBe('x');
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://bitbucket.example.com/rest/api/1.0/projects/P/repos/r/browse/docs/a%20b%231.md?at=feature%2Fx&start=0',
    );
  });
});

describe('BitbucketServerProvider — retries a transient 5xx on comment posting', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries once on a 500 and succeeds on the second attempt', async () => {
    const provider = new BitbucketServerProvider('https://bitbucket.example.com', 'test-token');
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Something went wrong' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const promise = provider.postInlineComment('P', 'r', 1, { text: 'note', path: 'a.ts', line: 1, lineKind: 'added' });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx response — that is a real client error, not transient', async () => {
    const provider = new BitbucketServerProvider('https://bitbucket.example.com', 'test-token');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad anchor' });

    await provider.postInlineComment('P', 'r', 1, { text: 'note', path: 'a.ts', line: 1, lineKind: 'added' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting all attempts and returns the last 5xx response', async () => {
    const provider = new BitbucketServerProvider('https://bitbucket.example.com', 'test-token');
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => 'still down' });

    const promise = provider.postInlineComment('P', 'r', 1, { text: 'note', path: 'a.ts', line: 1, lineKind: 'added' });
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});
