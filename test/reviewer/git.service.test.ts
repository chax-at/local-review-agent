import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { GitService, buildGitEnv } from '../../src/reviewer/git.service';

// Mock child_process
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

describe('GitService', () => {
  let gitService: GitService;

  beforeEach(() => {
    vi.clearAllMocks();
    gitService = new GitService('./repos', {
      cloneUrlFor: (p, s) => `https://bitbucket.example.com/scm/${p}/${s}.git`,
      authScopeUrl: 'https://bitbucket.example.com/',
      token: 'test-token',
    });
  });

  describe('getRepoDir', () => {
    it('should return an absolute path under the resolved workDir', () => {
      // workDir is resolved to absolute in the constructor (so Docker mounts work).
      const expected = path.resolve('./repos', 'PROJ', 'my-repo');
      expect(gitService.getRepoDir('PROJ', 'my-repo')).toBe(expected);
      expect(path.isAbsolute(gitService.getRepoDir('PROJ', 'my-repo'))).toBe(true);
    });
  });

  describe('cloneOrFetch', () => {
    it('should clone if repo dir does not exist', () => {
      (existsSync as any).mockReturnValue(false);
      gitService.cloneOrFetch('PROJ', 'repo');
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['clone']),
        expect.any(Object),
      );
    });

    it('should fetch only origin with prune if repo dir exists', () => {
      (existsSync as any).mockReturnValue(true);
      gitService.cloneOrFetch('PROJ', 'repo');
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin', '--prune'],
        expect.objectContaining({ cwd: expect.stringContaining('PROJ/repo') }),
      );
    });

    it('should skip the fetch when the repo was already fetched this cycle', () => {
      (existsSync as any).mockReturnValue(true);
      gitService.cloneOrFetch('PROJ', 'repo');
      (execFileSync as any).mockClear();
      gitService.cloneOrFetch('PROJ', 'repo');
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('should fetch again after resetFetchMemo()', () => {
      (existsSync as any).mockReturnValue(true);
      gitService.cloneOrFetch('PROJ', 'repo');
      (execFileSync as any).mockClear();
      gitService.resetFetchMemo();
      gitService.cloneOrFetch('PROJ', 'repo');
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin', '--prune'],
        expect.any(Object),
      );
    });

    it('should not skip the fetch for a different repo', () => {
      (existsSync as any).mockReturnValue(true);
      gitService.cloneOrFetch('PROJ', 'repo');
      (execFileSync as any).mockClear();
      gitService.cloneOrFetch('PROJ', 'other-repo');
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin', '--prune'],
        expect.objectContaining({ cwd: expect.stringContaining('PROJ/other-repo') }),
      );
    });

    it('should skip the fetch after a clone in the same cycle', () => {
      (existsSync as any).mockReturnValue(false);
      gitService.cloneOrFetch('PROJ', 'repo');
      (existsSync as any).mockReturnValue(true);
      (execFileSync as any).mockClear();
      gitService.cloneOrFetch('PROJ', 'repo');
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('should use credential-free clone URL', () => {
      (existsSync as any).mockReturnValue(false);
      gitService.cloneOrFetch('PROJ', 'repo');
      const cloneArgs = (execFileSync as any).mock.calls[0][1] as string[];
      const cloneUrl = cloneArgs.find((a: string) => a.includes('bitbucket'));
      expect(cloneUrl).toBe('https://bitbucket.example.com/scm/PROJ/repo.git');
      expect(cloneUrl).not.toContain('@');
    });
  });

  describe('resetToRemoteBranch', () => {
    /**
     * Configure the execFileSync mock to answer the fast-path inspection
     * commands. Any other git command returns an empty buffer.
     */
    const mockGitState = (state: {
      currentBranch?: string | Error;
      head: string;
      remoteHead: string;
      status?: string;
    }) => {
      (execFileSync as any).mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'symbolic-ref') {
          if (state.currentBranch instanceof Error) throw state.currentBranch;
          return Buffer.from(`${state.currentBranch ?? 'feature'}\n`);
        }
        if (args[0] === 'rev-parse') {
          return Buffer.from(`${state.head}\n${state.remoteHead}\n`);
        }
        if (args[0] === 'status') {
          return Buffer.from(state.status ?? '');
        }
        return Buffer.from('');
      });
    };

    const treeMutatingCalls = () =>
      (execFileSync as any).mock.calls.filter((c: [string, string[]]) =>
        ['reset', 'clean', 'checkout'].includes(c[1][0]),
      );

    it('skips the reset when already on the target branch at the origin commit with a clean tree', () => {
      mockGitState({ currentBranch: 'feature', head: 'abc123', remoteHead: 'abc123', status: '' });
      gitService.resetToRemoteBranch('PROJ', 'repo', 'feature');
      expect(treeMutatingCalls()).toHaveLength(0);
    });

    it('performs the full reset when HEAD differs from origin/<branch>', () => {
      mockGitState({ currentBranch: 'feature', head: 'abc123', remoteHead: 'def456' });
      gitService.resetToRemoteBranch('PROJ', 'repo', 'feature');
      expect(execFileSync).toHaveBeenCalledWith('git', ['checkout', 'feature'], expect.any(Object));
      expect(execFileSync).toHaveBeenCalledWith('git', ['reset', '--hard', 'origin/feature'], expect.any(Object));
      expect(execFileSync).toHaveBeenCalledWith('git', ['clean', '-fd'], expect.any(Object));
    });

    it('performs the full reset when the working tree is dirty', () => {
      mockGitState({ currentBranch: 'feature', head: 'abc123', remoteHead: 'abc123', status: ' M src/foo.ts\n' });
      gitService.resetToRemoteBranch('PROJ', 'repo', 'feature');
      expect(treeMutatingCalls().length).toBeGreaterThan(0);
    });

    it('performs the full reset when on a different branch even at the same commit', () => {
      mockGitState({ currentBranch: 'other', head: 'abc123', remoteHead: 'abc123', status: '' });
      gitService.resetToRemoteBranch('PROJ', 'repo', 'feature');
      expect(execFileSync).toHaveBeenCalledWith('git', ['checkout', 'feature'], expect.any(Object));
    });

    it('performs the full reset when HEAD is detached (symbolic-ref fails)', () => {
      mockGitState({ currentBranch: new Error('fatal: ref HEAD is not a symbolic ref'), head: 'abc123', remoteHead: 'abc123', status: '' });
      gitService.resetToRemoteBranch('PROJ', 'repo', 'feature');
      expect(execFileSync).toHaveBeenCalledWith('git', ['checkout', 'feature'], expect.any(Object));
    });
  });

  describe('getDiff', () => {
    it('should call git diff with correct refs', () => {
      (execFileSync as any).mockReturnValue(Buffer.from('diff output'));
      const diff = gitService.getDiff('PROJ', 'repo', 'main', 'feature-branch');
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['diff', 'origin/main...origin/feature-branch'],
        expect.any(Object),
      );
      expect(diff).toBe('diff output');
    });
  });

  describe('redactPat', () => {
    it('returns text unchanged when PAT is empty', () => {
      const empty = new GitService('./repos', {
        cloneUrlFor: (p, s) => `https://example.com/scm/${p}/${s}.git`,
        authScopeUrl: 'https://example.com/',
        token: '',
      });
      expect(empty.redactPat('error connecting to https://example.com')).toBe('error connecting to https://example.com');
    });

    it('redacts the raw PAT', () => {
      const out = gitService.redactPat('fatal: unable to access https://test-user:test-token@bitbucket.example.com/scm/foo/bar.git');
      expect(out).not.toContain('test-token');
      expect(out).toContain('***');
    });

    it('redacts the URL-encoded PAT', () => {
      const svc = new GitService('./repos', {
        cloneUrlFor: (p, s) => `https://example.com/scm/${p}/${s}.git`,
        authScopeUrl: 'https://example.com/',
        token: 'tok+en/with#chars',
      });
      const out = svc.redactPat('https://user:tok%2Ben%2Fwith%23chars@example.com');
      expect(out).not.toContain('tok%2Ben');
      expect(out).toContain('***');
    });
  });

  describe('getCloneUrl', () => {
    it('returns a credential-free URL', () => {
      // Reach through the typing — getCloneUrl is private, so cast for the test.
      const url = (gitService as unknown as { getCloneUrl(p: string, s: string): string })
        .getCloneUrl('PROJ', 'repo');
      expect(url).toBe('https://bitbucket.example.com/scm/PROJ/repo.git');
      expect(url).not.toContain('@');
      expect(url).not.toContain('test-token');
      expect(url).not.toContain('test-user');
    });
  });
});

describe('buildGitEnv', () => {
  it('returns an empty object when token is empty', () => {
    expect(buildGitEnv({
      cloneUrlFor: (p, s) => `https://example.com/scm/${p}/${s}.git`,
      authScopeUrl: 'https://example.com/',
      token: '',
    })).toEqual({});
  });

  it('returns GIT_CONFIG_PARAMETERS with the Bearer header for the given URL', () => {
    const env = buildGitEnv({
      cloneUrlFor: (p, s) => `https://example.com/scm/${p}/${s}.git`,
      authScopeUrl: 'https://example.com',
      token: 'test-token',
    });
    expect(env).toEqual({
      GIT_CONFIG_PARAMETERS: "'http.https://example.com/.extraheader=Authorization: Bearer test-token'",
    });
  });

  it('appends a trailing slash to the URL key when missing', () => {
    const env = buildGitEnv({
      cloneUrlFor: (p, s) => `https://example.com/scm/${p}/${s}.git`,
      authScopeUrl: 'https://example.com',
      token: 'p',
    });
    expect(env.GIT_CONFIG_PARAMETERS).toContain('http.https://example.com/.extraheader');
  });

  it('does not append a trailing slash when the URL already ends with one', () => {
    const env = buildGitEnv({
      cloneUrlFor: (p, s) => `https://example.com/scm/${p}/${s}.git`,
      authScopeUrl: 'https://example.com/',
      token: 'p',
    });
    expect(env.GIT_CONFIG_PARAMETERS).toContain('http.https://example.com/.extraheader');
    expect(env.GIT_CONFIG_PARAMETERS).not.toContain('https://example.com//.extraheader');
  });

  it('escapes single quotes in the token to keep the GIT_CONFIG_PARAMETERS value well-formed', () => {
    const env = buildGitEnv({
      cloneUrlFor: (p, s) => `https://example.com/scm/${p}/${s}.git`,
      authScopeUrl: 'https://example.com/',
      token: "a'b'c",
    });
    expect(env.GIT_CONFIG_PARAMETERS).toBe(
      "'http.https://example.com/.extraheader=Authorization: Bearer a'\\''b'\\''c'",
    );
  });

  it('uses Basic auth when gitConfig.email is set', () => {
    const env = buildGitEnv({
      cloneUrlFor: (_p, _s) => '',
      authScopeUrl: 'https://bitbucket.org/',
      token: 'tok',
      email: 'user@example.com',
    });
    const expectedBasic = Buffer.from('user@example.com:tok').toString('base64');
    expect(env.GIT_CONFIG_PARAMETERS).toContain(`Authorization: Basic ${expectedBasic}`);
    expect(env.GIT_CONFIG_PARAMETERS).not.toContain('Bearer');
  });
});
