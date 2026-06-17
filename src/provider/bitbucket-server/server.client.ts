// src/provider/bitbucket-server/server.client.ts
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../../log/tags';
import type {
  IPullRequest,
  IComment,
  IActivity,
  IInlineCommentInput,
  IBuildStatus,
  IProject,
  IRepo,
  IGitConfig,
} from '../provider.types';
import { GitProviderAuthError, type IGitProvider } from '../provider';
import type {
  IBitbucketPullRequest,
  IBitbucketPagedResponse,
  IBitbucketActivity,
  IBitbucketComment,
  IBitbucketProject,
  IBitbucketRepo,
  IBitbucketBuildStatus,
  IBitbucketCreatePrPayload,
} from './server.types';
import {
  toPullRequest,
  toComment,
  toActivity,
  toBuildStatus,
  toProject,
  toRepo,
  toServerInlineCommentPayload,
} from './server.mappers';

export class BitbucketServerProvider implements IGitProvider {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  public getGitConfig(): IGitConfig {
    const base = this.baseUrl;
    const { token } = this;
    return {
      cloneUrlFor: (project: string, slug: string): string => {
        const url = new URL(base);
        return `${url.protocol}//${url.host}/scm/${project}/${slug}.git`;
      },
      authScopeUrl: base.endsWith('/') ? base : `${base}/`,
      token,
    };
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private repoApi(project: string, slug: string): string {
    return `${this.baseUrl}/rest/api/1.0/projects/${project}/repos/${slug}`;
  }

  /** Retries fetch on network failures (TypeError: fetch failed, ECONNRESET, etc.). */
  private async fetchWithNetworkRetry(url: string, init?: RequestInit): Promise<Response> {
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fetch(url, init);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === maxAttempts - 1) {
          LogSink.error(`Bitbucket fetch failed after ${maxAttempts} attempts: ${msg}`, TraceTags.BITBUCKET);
          throw err;
        }
        const waitMs = Math.pow(2, attempt) * 1000;
        LogSink.warn(
          `Bitbucket fetch failed (${msg}), retry in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`,
          TraceTags.BITBUCKET,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw new Error('Bitbucket fetchWithNetworkRetry: unreachable');
  }

  private async fetchAllPages<T>(url: string): Promise<T[]> {
    const results: T[] = [];
    let nextPageStart: number | undefined = 0;

    while (nextPageStart !== undefined) {
      const separator = url.includes('?') ? '&' : '?';
      const pagedUrl = `${url}${separator}start=${nextPageStart}&limit=100`;

      let response: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await this.fetchWithNetworkRetry(pagedUrl, { headers: this.headers });
        if (response.status === 429) {
          const waitMs = Math.pow(2, attempt) * 5000;
          LogSink.warn(
            `Bitbucket rate limited, waiting ${waitMs}ms (attempt ${attempt + 1}/3)...`,
            TraceTags.BITBUCKET,
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        break;
      }

      if (!response || !response.ok) {
        const status = response?.status ?? 0;
        if (status === 401 || status === 403) {
          throw new GitProviderAuthError(`Bitbucket auth failed (${status}). Check PAT.`);
        }
        throw new Error(`Bitbucket API error: ${status} for ${pagedUrl}`);
      }

      const page = (await response.json()) as IBitbucketPagedResponse<T>;
      results.push(...page.values);
      nextPageStart = page.isLastPage ? undefined : page.nextPageStart;
    }

    return results;
  }

  public async listProjects(): Promise<IProject[]> {
    const wires = await this.fetchAllPages<IBitbucketProject>(`${this.baseUrl}/rest/api/1.0/projects`);
    return wires.map(toProject);
  }

  public async listRepos(projectKey: string): Promise<IRepo[]> {
    const wires = await this.fetchAllPages<IBitbucketRepo>(`${this.baseUrl}/rest/api/1.0/projects/${projectKey}/repos`);
    return wires.map(toRepo);
  }

  public async listBranches(project: string, slug: string): Promise<string[]> {
    const branches = await this.fetchAllPages<{ displayId: string }>(`${this.repoApi(project, slug)}/branches`);
    return branches.map((b) => b.displayId);
  }

  public async getBranchLatestCommit(project: string, slug: string, branch: string): Promise<string | null> {
    const url = `${this.repoApi(project, slug)}/commits?until=${encodeURIComponent(branch)}&limit=1`;
    try {
      const response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
      if (!response.ok) return null;
      const page = (await response.json()) as IBitbucketPagedResponse<{ id: string }>;
      return page.values[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  public async getLatestCommitTimestampMs(project: string, slug: string): Promise<number | null> {
    try {
      const url = `${this.repoApi(project, slug)}/commits?limit=1`;
      const response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
      if (!response.ok) return null;
      const page = (await response.json()) as IBitbucketPagedResponse<{
        authorTimestamp?: number;
        committerTimestamp?: number;
      }>;
      const c = page.values[0];
      const t = c?.authorTimestamp ?? c?.committerTimestamp;
      return typeof t === 'number' ? t : null;
    } catch {
      return null;
    }
  }

  public async getOpenPullRequests(project: string, slug: string): Promise<IPullRequest[]> {
    const wires = await this.fetchAllPages<IBitbucketPullRequest>(
      `${this.repoApi(project, slug)}/pull-requests?state=OPEN`,
    );
    return wires.map(toPullRequest);
  }

  public async getPullRequest(project: string, slug: string, prId: number): Promise<IPullRequest | null> {
    const url = `${this.repoApi(project, slug)}/pull-requests/${prId}`;
    const response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
    if (!response.ok) {
      LogSink.warn(`Bitbucket API: getPullRequest failed ${response.status}`, TraceTags.BITBUCKET);
      return null;
    }
    return toPullRequest((await response.json()) as IBitbucketPullRequest);
  }

  public async isPrOpen(project: string, slug: string, prId: number): Promise<boolean> {
    const pr = await this.getPullRequest(project, slug, prId);
    return pr?.isOpen === true;
  }

  public async createFixPr(
    project: string,
    slug: string,
    title: string,
    description: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<number> {
    const prId = await this.createPullRequestInternal(project, slug, title, description, fromBranch, toBranch);
    await this.setPrDeleteBranchOnMerge(project, slug, prId);
    return prId;
  }

  private async createPullRequestInternal(
    project: string,
    slug: string,
    title: string,
    description: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<number> {
    const url = `${this.repoApi(project, slug)}/pull-requests`;
    const payload: IBitbucketCreatePrPayload = {
      title,
      description,
      fromRef: { id: `refs/heads/${fromBranch}`, repository: { slug, project: { key: project } } },
      toRef: { id: `refs/heads/${toBranch}`, repository: { slug, project: { key: project } } },
    };
    const response = await this.fetchWithNetworkRetry(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to create PR: ${response.status} ${text}`);
    }
    const result = (await response.json()) as { id: number };
    return result.id;
  }

  private async setPrDeleteBranchOnMerge(project: string, slug: string, prId: number): Promise<void> {
    const rawResp = await this.fetchWithNetworkRetry(`${this.repoApi(project, slug)}/pull-requests/${prId}`, {
      headers: this.headers,
    });
    if (!rawResp.ok) return;
    const raw = (await rawResp.json()) as IBitbucketPullRequest;

    const url = `${this.repoApi(project, slug)}/pull-requests/${prId}`;
    try {
      const response = await this.fetchWithNetworkRetry(url, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({
          version: raw.version ?? 0,
          title: raw.title,
          properties: { deleteSourceBranchOnMerge: true },
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        LogSink.warn(
          `Failed to set deleteSourceBranchOnMerge on PR #${prId}: ${response.status} ${text}`,
          TraceTags.BITBUCKET,
        );
      }
    } catch (err) {
      LogSink.warn(`Failed to set deleteSourceBranchOnMerge on PR #${prId}: ${err}`, TraceTags.BITBUCKET);
    }
  }

  public async getActivities(project: string, slug: string, prId: number): Promise<IActivity[]> {
    const wires = await this.fetchAllPages<IBitbucketActivity>(
      `${this.repoApi(project, slug)}/pull-requests/${prId}/activities`,
    );
    return wires.map(toActivity);
  }

  public async getComments(project: string, slug: string, prId: number): Promise<IComment[]> {
    // DC has no direct list-comments endpoint; extract from activities.
    const activities = await this.getActivities(project, slug, prId);
    return activities.flatMap((a) => (a.comment ? [a.comment] : []));
  }

  public async getComment(project: string, slug: string, prId: number, commentId: number): Promise<IComment | null> {
    const url = `${this.repoApi(project, slug)}/pull-requests/${prId}/comments/${commentId}`;
    try {
      const response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
      if (!response.ok) return null;
      const wire = (await response.json()) as IBitbucketComment & {
        comments?: Array<{ id: number; text: string; author: { slug: string } }>;
      };
      return toComment(wire);
    } catch {
      return null;
    }
  }

  public async postInlineComment(
    project: string,
    slug: string,
    prId: number,
    input: IInlineCommentInput,
  ): Promise<void> {
    const url = `${this.repoApi(project, slug)}/pull-requests/${prId}/comments`;
    const payload = toServerInlineCommentPayload(input);
    const response = await this.fetchWithNetworkRetry(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      LogSink.error(`Failed to post comment: ${response.status} ${text}`, TraceTags.BITBUCKET);
    }
  }

  public async postGeneralComment(project: string, slug: string, prId: number, text: string): Promise<number | null> {
    const url = `${this.repoApi(project, slug)}/pull-requests/${prId}/comments`;
    const response = await this.fetchWithNetworkRetry(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const body = await response.text();
      LogSink.error(`Failed to post general comment: ${response.status} ${body}`, TraceTags.BITBUCKET);
      return null;
    }
    const json = (await response.json()) as { id?: number };
    return json.id ?? null;
  }

  public async replyToComment(
    project: string,
    slug: string,
    prId: number,
    parentCommentId: number,
    text: string,
  ): Promise<void> {
    const url = `${this.repoApi(project, slug)}/pull-requests/${prId}/comments`;
    const response = await this.fetchWithNetworkRetry(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ text, parent: { id: parentCommentId } }),
    });
    if (!response.ok) {
      const body = await response.text();
      LogSink.error(`Failed to reply to comment ${parentCommentId}: ${response.status} ${body}`, TraceTags.BITBUCKET);
    }
  }

  public async updateComment(
    project: string,
    slug: string,
    prId: number,
    commentId: number,
    text: string,
  ): Promise<void> {
    // DC needs the version for optimistic locking; fetch raw, then PUT.
    const rawResp = await this.fetchWithNetworkRetry(
      `${this.repoApi(project, slug)}/pull-requests/${prId}/comments/${commentId}`,
      { headers: this.headers },
    );
    if (!rawResp.ok) return;
    const raw = (await rawResp.json()) as { version: number };

    const url = `${this.repoApi(project, slug)}/pull-requests/${prId}/comments/${commentId}`;
    const response = await this.fetchWithNetworkRetry(url, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ text, version: raw.version }),
    });
    if (!response.ok) {
      const body = await response.text();
      LogSink.error(`Failed to update comment ${commentId}: ${response.status} ${body}`, TraceTags.BITBUCKET);
    }
  }

  public async getBuildStatuses(_project: string, _slug: string, commitId: string): Promise<IBuildStatus[]> {
    const url = `${this.baseUrl}/rest/build-status/1.0/commits/${commitId}`;
    const wires = await this.fetchAllPages<IBitbucketBuildStatus>(url);
    return wires.map(toBuildStatus);
  }

  public async getFileContent(
    project: string,
    slug: string,
    filePath: string,
    opts?: { at?: string; quiet?: boolean },
  ): Promise<string | null> {
    const branch = opts?.at;
    let url = `${this.repoApi(project, slug)}/browse/${filePath}`;
    if (branch) url += `?at=${encodeURIComponent(branch)}`;
    if (!opts?.quiet) {
      LogSink.debug(`Bitbucket API: GET file ${filePath} (branch=${branch ?? 'default'})`, TraceTags.BITBUCKET);
    }
    try {
      const response = await this.fetchWithNetworkRetry(url, {
        headers: { ...this.headers, Accept: 'application/json' },
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { lines?: { text: string }[] };
      if (!data.lines) return null;
      return data.lines.map((l) => l.text).join('\n');
    } catch {
      return null;
    }
  }
}
