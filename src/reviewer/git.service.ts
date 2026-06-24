import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IGitConfig } from '../provider/provider.types';

/**
 * Build the env-var dictionary that makes git attach an `Authorization` header
 * to all requests under `gitConfig.authScopeUrl`. Returns `{}` when the token
 * is empty so callers don't accidentally configure an empty header.
 *
 * When `gitConfig.email` is set, uses HTTP Basic auth (`email:token` base64).
 * Otherwise falls back to Bearer.
 *
 * Pure (no I/O) — exported separately from GitService so it can be unit-tested.
 */
export function buildGitEnv(gitConfig: IGitConfig): NodeJS.ProcessEnv {
  if (!gitConfig.token) return {};
  const url = gitConfig.authScopeUrl.endsWith('/') ? gitConfig.authScopeUrl : `${gitConfig.authScopeUrl}/`;
  const headerValue = gitConfig.email
    ? `Basic ${Buffer.from(`${gitConfig.email}:${gitConfig.token}`).toString('base64')}`
    : `Bearer ${gitConfig.token}`;
  // GIT_CONFIG_PARAMETERS wraps the value in single quotes; escape any embedded single quotes.
  const escapedHeader = headerValue.replace(/'/g, "'\\''");
  return {
    GIT_CONFIG_PARAMETERS: `'http.${url}.extraheader=Authorization: ${escapedHeader}'`,
  };
}

export class GitService {
  private readonly workDir: string;
  private readonly gitConfig: IGitConfig;
  /**
   * Repos (as `project/slug`) already cloned or fetched this poll cycle.
   * Lets `cloneOrFetch` skip redundant network round trips when several PRs
   * of the same repo are processed in one cycle. Cleared via `resetFetchMemo`.
   */
  private readonly fetchedRepos = new Set<string>();

  constructor(workDir: string, gitConfig: IGitConfig) {
    // Resolve to absolute so Docker volume mounts (pi runner) work
    // — relative paths like "./repos" are rejected as invalid volume names.
    this.workDir = path.resolve(workDir);
    this.gitConfig = gitConfig;
  }

  public getRepoDir(project: string, slug: string): string {
    return path.join(this.workDir, project, slug);
  }

  private getCloneUrl(project: string, slug: string): string {
    return this.gitConfig.cloneUrlFor(project, slug);
  }

  /** Redact token from error messages to prevent credential leaks in logs */
  private redact(text: string): string {
    const { token } = this.gitConfig;
    if (!token) return text;
    return text.split(encodeURIComponent(token)).join('***').split(token).join('***');
  }

  /**
   * Public version of `redact` for callers (e.g. failure-comment posting) that
   * may forward error text containing the PAT to user-visible surfaces.
   */
  public redactPat(text: string): string {
    return this.redact(text);
  }

  /** Wrap execFileSync errors to redact credentials and inject Bearer auth env. */
  public execGit(args: string[], opts: Parameters<typeof execFileSync>[2]): string {
    const baseOpts = opts ?? {};
    const callerEnv = (baseOpts as { env?: NodeJS.ProcessEnv }).env;
    const merged = {
      ...baseOpts,
      env: {
        ...process.env,
        ...buildGitEnv(this.gitConfig),
        ...(callerEnv ?? {}),
      },
    };
    try {
      return execFileSync('git', args, merged)?.toString() ?? '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(this.redact(msg));
    }
  }

  /** Forget which repos were fetched; call at the start of every poll cycle. */
  public resetFetchMemo(): void {
    this.fetchedRepos.clear();
  }

  public cloneOrFetch(project: string, slug: string): void {
    const repoDir = this.getRepoDir(project, slug);
    const repoKey = `${project}/${slug}`;

    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      const parentDir = path.dirname(repoDir);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      const cloneUrl = this.getCloneUrl(project, slug);
      LogSink.info(`Cloning ${project}/${slug}...`, TraceTags.GIT);
      LogSink.debug(`Clone target: ${repoDir}`, TraceTags.GIT);
      this.execGit(['clone', cloneUrl, repoDir], {
        stdio: 'pipe',
        timeout: 120000,
      });
      this.fetchedRepos.add(repoKey);
    } else {
      if (this.fetchedRepos.has(repoKey)) {
        LogSink.debug(`Skipping fetch for ${repoKey} (already fetched this cycle)`, TraceTags.GIT);
        return;
      }
      // Update remote URL so it stays credential-free (drops any legacy URL-embedded
      // creds from older clones) and picks up any host/port changes.
      const cloneUrl = this.getCloneUrl(project, slug);
      this.execGit(['remote', 'set-url', 'origin', cloneUrl], { cwd: repoDir, stdio: 'pipe' });
      LogSink.info(`Fetching ${project}/${slug}...`, TraceTags.GIT);
      this.execGit(['fetch', 'origin', '--prune'], {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 60000,
      });
      this.fetchedRepos.add(repoKey);
    }
  }

  public getDiff(project: string, slug: string, targetBranch: string, sourceBranch: string): string {
    const repoDir = this.getRepoDir(project, slug);
    LogSink.debug(`Diff: origin/${targetBranch}...origin/${sourceBranch} in ${repoDir}`, TraceTags.GIT);
    return this.execGit(['diff', `origin/${targetBranch}...origin/${sourceBranch}`], {
      cwd: repoDir,
      maxBuffer: 50 * 1024 * 1024,
    });
  }

  public getFileFromBranch(project: string, slug: string, branch: string, filePath: string): string | null {
    const repoDir = this.getRepoDir(project, slug);
    try {
      const output = this.execGit(['show', `origin/${branch}:${filePath}`], { cwd: repoDir, stdio: 'pipe' });
      LogSink.debug(`Read ${filePath} from origin/${branch} (${output.length} bytes)`, TraceTags.GIT);
      return output;
    } catch {
      LogSink.debug(`File ${filePath} not found on origin/${branch}`, TraceTags.GIT);
      return null;
    }
  }

  /**
   * Fast-path check for `resetToRemoteBranch`: true when the working tree is
   * already on `branch`, at the `origin/<branch>` commit, with no local
   * changes — i.e. the expensive reset sequence would be a no-op.
   *
   * The branch-name check matters: being at the right commit on a *different*
   * branch is not enough, because later `commitAndPush` calls rely on the
   * current branch's upstream.
   */
  private isAtRemoteBranch(repoDir: string, branch: string): boolean {
    try {
      const currentBranch = this.execGit(['symbolic-ref', '--short', 'HEAD'], { cwd: repoDir, stdio: 'pipe' }).trim();
      if (currentBranch !== branch) return false;
      const [head, remoteHead] = this.execGit(['rev-parse', 'HEAD', `origin/${branch}`], {
        cwd: repoDir,
        stdio: 'pipe',
      })
        .trim()
        .split('\n');
      if (!head || head !== remoteHead) return false;
      const status = this.execGit(['status', '--porcelain'], { cwd: repoDir, stdio: 'pipe' });
      return !status.trim();
    } catch {
      // Detached HEAD, missing remote ref, etc. — fall back to the full reset.
      return false;
    }
  }

  public resetToRemoteBranch(project: string, slug: string, branch: string): void {
    const repoDir = this.getRepoDir(project, slug);
    if (this.isAtRemoteBranch(repoDir, branch)) {
      LogSink.debug(`${project}/${slug} already at origin/${branch}, skipping reset`, TraceTags.GIT);
      return;
    }
    LogSink.debug(`Resetting ${project}/${slug} to origin/${branch}`, TraceTags.GIT);
    // Discard any leftover changes from a previous operation (e.g. a rejected fix)
    // before switching branches — otherwise checkout fails on dirty working tree.
    this.execGit(['reset', '--hard', 'HEAD'], { cwd: repoDir, stdio: 'pipe' });
    this.execGit(['clean', '-fd'], { cwd: repoDir, stdio: 'pipe' });
    this.execGit(['checkout', branch], { cwd: repoDir, stdio: 'pipe' });
    this.execGit(['reset', '--hard', `origin/${branch}`], { cwd: repoDir, stdio: 'pipe' });
  }

  public pushBranch(project: string, slug: string, branch: string): void {
    const repoDir = this.getRepoDir(project, slug);
    this.execGit(['push', 'origin', branch], { cwd: repoDir, stdio: 'pipe', timeout: 120000 });
  }

  public createBranchCommitAndPush(project: string, slug: string, branch: string, commitMsg: string): void {
    const repoDir = this.getRepoDir(project, slug);
    this.execGit(['checkout', '-b', branch], { cwd: repoDir, stdio: 'pipe' });
    this.execGit(['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    this.execGit(['commit', '-m', commitMsg], { cwd: repoDir, stdio: 'pipe' });
    this.pushBranch(project, slug, branch);
  }

  public commitAndPush(project: string, slug: string, message: string): string {
    const repoDir = this.getRepoDir(project, slug);
    this.execGit(['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    this.execGit(['commit', '-m', message], { cwd: repoDir, stdio: 'pipe' });

    try {
      this.execGit(['push'], { cwd: repoDir, stdio: 'pipe' });
    } catch {
      LogSink.warn('Push failed, trying pull --rebase...', TraceTags.GIT);
      this.execGit(['pull', '--rebase'], { cwd: repoDir, stdio: 'pipe' });
      this.execGit(['push'], { cwd: repoDir, stdio: 'pipe' });
    }

    return this.execGit(['rev-parse', '--short', 'HEAD'], { cwd: repoDir, stdio: 'pipe' }).trim();
  }
}
