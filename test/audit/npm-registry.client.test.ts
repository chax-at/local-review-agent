import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NpmRegistryClient } from '../../src/audit/npm-registry.client';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('NpmRegistryClient', () => {
  let client: NpmRegistryClient;

  beforeEach(() => {
    client = new NpmRegistryClient();
    mockFetch.mockReset();
  });

  describe('getNextSafeVersion', () => {
    it('returns exact version for strict less-than range', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          versions: { '2.1.0': {}, '2.1.1': {}, '2.1.2': {} },
        }),
      });
      const result = await client.getNextSafeVersion('picomatch', '<2.1.1');
      expect(result).toBe('2.1.1');
    });

    it('returns next published version for inclusive upper bound', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          versions: { '10.3.0': {}, '10.3.1': {}, '10.3.2': {}, '10.4.0': {} },
        }),
      });
      const result = await client.getNextSafeVersion('some-pkg', '<=10.3.1');
      expect(result).toBe('10.3.2');
    });

    it('returns null when no version is above the boundary', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          versions: { '1.0.0': {}, '1.0.1': {} },
        }),
      });
      const result = await client.getNextSafeVersion('some-pkg', '<=1.0.1');
      expect(result).toBeNull();
    });

    it('returns null on fetch failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network'));
      const result = await client.getNextSafeVersion('bad-pkg', '<1.0.0');
      expect(result).toBeNull();
    });
  });

  describe('getRepoInfo', () => {
    it('extracts GitHub repo URL and builds compare URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          repository: { type: 'git', url: 'git+https://github.com/micromatch/picomatch.git' },
        }),
      });
      const info = await client.getRepoInfo('picomatch', '2.3.1', '4.0.2');
      expect(info.repoUrl).toBe('https://github.com/micromatch/picomatch');
      expect(info.compareUrl).toBe('https://github.com/micromatch/picomatch/compare/v2.3.1...v4.0.2');
    });

    it('returns nulls when no repository field', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const info = await client.getRepoInfo('no-repo-pkg', '1.0.0', '2.0.0');
      expect(info.repoUrl).toBeNull();
      expect(info.compareUrl).toBeNull();
    });
  });

  describe('getChangelog', () => {
    it('returns concatenated GitHub release bodies', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { tag_name: 'v2.0.0', body: 'Release 2.0.0 notes' },
          { tag_name: 'v1.5.0', body: 'Release 1.5.0 notes' },
          { tag_name: 'v1.0.0', body: 'Old release' },
        ]),
      });
      const result = await client.getChangelog('test-pkg', '1.0.0', '2.0.0', 'https://github.com/owner/repo');
      expect(result).toContain('Release 2.0.0 notes');
      expect(result).toContain('Release 1.5.0 notes');
      expect(result).not.toContain('Old release');
    });

    it('returns null when no releases found', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      const result = await client.getChangelog('test-pkg', '1.0.0', '2.0.0', 'https://github.com/owner/repo');
      expect(result).toBeNull();
    });

    it('returns null when repoUrl is null', async () => {
      const result = await client.getChangelog('test-pkg', '1.0.0', '2.0.0', null);
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('getLatestVersion', () => {
    it('returns latest version and publish date', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '4.0.2' },
          time: { '4.0.2': '2026-01-15T00:00:00.000Z' },
        }),
      });
      const result = await client.getLatestVersion('picomatch');
      expect(result).toEqual({ version: '4.0.2', publishedAt: '2026-01-15T00:00:00.000Z' });
    });

    it('returns null on failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      const result = await client.getLatestVersion('nonexistent');
      expect(result).toBeNull();
    });
  });
});
