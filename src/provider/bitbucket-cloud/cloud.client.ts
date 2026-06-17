// src/provider/bitbucket-cloud/cloud.client.ts
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
import { toPullRequestCloud, toCommentCloud, toBuildStatusCloud, toRepoCloud } from './cloud.mappers';
import type {
  ICloudPagedResponse,
  ICloudPullRequest,
  ICloudRepository,
  ICloudBranch,
  ICloudCommit,
  ICloudComment,
  ICloudBuildStatus,
  ICloudCreatePrPayload,
} from './cloud.types';

const API_BASE = 'https://api.bitbucket.org/2.0';
const GIT_BASE = 'https://bitbucket.org';

export class BitbucketCloudProvider implements IGitProvider {
  private readonly workspace: string;
  private readonly token: string;
  private readonly email?: string;
  private readonly authHeader: string;

  constructor(workspace: string, token: string, email?: string) {
    this.workspace = workspace;
    this.token = token;
    this.email = email;
    this.authHeader = email ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`;
  }

  public getGitConfig(): IGitConfig {
    const ws = this.workspace;
    const { token } = this;
    // Bitbucket Cloud's REST API expects the Atlassian email as the Basic-auth
    // username, but git-over-HTTPS expects the static username
    // `x-bitbucket-api-token-auth`. Same token, different usernames per surface.
    // We only set `email` when REST auth is in Basic mode — that's also when
    // git-over-HTTPS needs Basic with the static username.
    const gitUsername = this.email ? 'x-bitbucket-api-token-auth' : undefined;
    return {
      cloneUrlFor: (_project: string, slug: string): string => `${GIT_BASE}/${ws}/${slug}.git`,
      authScopeUrl: `${GIT_BASE}/`,
      token,
      email: gitUsername,
    };
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
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
          LogSink.error(`Bitbucket Cloud fetch failed after ${maxAttempts} attempts: ${msg}`, TraceTags.BITBUCKET);
          throw err;
        }
        const waitMs = Math.pow(2, attempt) * 1000;
        LogSink.warn(
          `Bitbucket Cloud fetch failed (${msg}), retry in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`,
          TraceTags.BITBUCKET,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw new Error('Bitbucket Cloud fetchWithNetworkRetry: unreachable');
  }

  /** Follow `next` URLs until absent. */
  private async fetchAllPages<T>(firstUrl: string): Promise<T[]> {
    const results: T[] = [];
    let url: string | undefined = firstUrl;

    while (url) {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
        if (response.status === 429) {
          const waitMs = Math.pow(2, attempt) * 5000;
          LogSink.warn(
            `Bitbucket Cloud rate limited, waiting ${waitMs}ms (attempt ${attempt + 1}/3)...`,
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
          throw new GitProviderAuthError(`Bitbucket Cloud auth failed (${status}). Check Access Token.`);
        }
        throw new Error(`Bitbucket Cloud API error: ${status} for ${url}`);
      }

      const page = (await response.json()) as ICloudPagedResponse<T>;
      results.push(...page.values);
      url = page.next;
    }

    return results;
  }

  // ── Discovery ─────────────────────────────────────────────────────
  public async listProjects(): Promise<IProject[]> {
    return [{ key: this.workspace, name: this.workspace }];
  }

  public async listRepos(projectKey: string): Promise<IRepo[]> {
    const wires = await this.fetchAllPages<ICloudRepository>(`${API_BASE}/repositories/${projectKey}`);
    return wires.map((r) => toRepoCloud(r, projectKey));
  }

  public async listBranches(_project: string, slug: string): Promise<string[]> {
    const branches = await this.fetchAllPages<ICloudBranch>(
      `${API_BASE}/repositories/${this.workspace}/${slug}/refs/branches`,
    );
    return branches.map((b) => b.name);
  }

  public async getBranchLatestCommit(_project: string, slug: string, branch: string): Promise<string | null> {
    const url = `${API_BASE}/repositories/${this.workspace}/${slug}/refs/branches/${encodeURIComponent(branch)}`;
    try {
      const response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
      if (!response.ok) return null;
      const data = (await response.json()) as ICloudBranch;
      return data.target?.hash ?? null;
    } catch {
      return null;
    }
  }

  public async getLatestCommitTimestampMs(_project: string, slug: string): Promise<number | null> {
    try {
      const url = `${API_BASE}/repositories/${this.workspace}/${slug}/commits?pagelen=1`;
      const response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
      if (!response.ok) return null;
      const page = (await response.json()) as ICloudPagedResponse<ICloudCommit>;
      const c = page.values[0];
      if (!c) return null;
      const t = Date.parse(c.date);
      return Number.isNaN(t) ? null : t;
    } catch {
      return null;
    }
  }

  // ── Pull requests ─────────────────────────────────────────────────
  public async getOpenPullRequests(_project: string, slug: string): Promise<IPullRequest[]> {
    const q = encodeURIComponent('state="OPEN"');
    const wires = await this.fetchAllPages<ICloudPullRequest>(
      `${API_BASE}/repositories/${this.workspace}/${slug}/pullrequests?q=${q}`,
    );
    return wires.map(toPullRequestCloud);
  }

  public async getPullRequest(_project: string, slug: string, prId: number): Promise<IPullRequest | null> {
    const url = `${API_BASE}/repositories/${this.workspace}/${slug}/pullrequests/${prId}`;
    const response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
    if (!response.ok) {
      LogSink.warn(`Bitbucket Cloud API: getPullRequest failed ${response.status}`, TraceTags.BITBUCKET);
      return null;
    }
    return toPullRequestCloud((await response.json()) as ICloudPullRequest);
  }

  public async isPrOpen(_project: string, slug: string, prId: number): Promise<boolean> {
    const pr = await this.getPullRequest(_project, slug, prId);
    return pr?.isOpen === true;
  }

  public async createFixPr(
    _project: string,
    slug: string,
    title: string,
    description: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<number> {
    const url = `${API_BASE}/repositories/${this.workspace}/${slug}/pullrequests`;
    const payload: ICloudCreatePrPayload = {
      title,
      description,
      source: { branch: { name: fromBranch } },
      destination: { branch: { name: toBranch } },
      close_source_branch: true,
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

  // ── Comments / activities ─────────────────────────────────────────
  public async getComments(_project: string, slug: string, prId: number): Promise<IComment[]> {
    const wires = await this.fetchAllPages<ICloudComment>(
      `${API_BASE}/repositories/${this.workspace}/${slug}/pullrequests/${prId}/comments`,
    );
    return wires.filter((c) => !c.deleted).map((c) => toCommentCloud(c, wires));
  }

  public async getActivities(_project: string, slug: string, prId: number): Promise<IActivity[]> {
    // Cloud has /activity but our consumers use activities only to discover comments.
    // Synthesise activities from comments: id = comment.id (monotonic per repo).
    const comments = await this.getComments(_project, slug, prId);
    return comments.map((c) => ({ id: c.id, comment: c }));
  }

  public async getComment(_project: string, slug: string, prId: number, commentId: number): Promise<IComment | null> {
    const url = `${API_BASE}/repositories/${this.workspace}/${slug}/pullrequests/${prId}/comments/${commentId}`;
    try {
      const response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
      if (!response.ok) return null;
      const wire = (await response.json()) as ICloudComment;
      // Children would need another fetch; consumers tolerate empty replies here.
      return toCommentCloud(wire, []);
    } catch {
      return null;
    }
  }

  public async postInlineComment(
    _project: string,
    slug: string,
    prId: number,
    input: IInlineCommentInput,
  ): Promise<void> {
    const url = `${API_BASE}/repositories/${this.workspace}/${slug}/pullrequests/${prId}/comments`;
    const inline =
      input.lineKind === 'removed' ? { path: input.path, from: input.line } : { path: input.path, to: input.line };
    const body = { content: { raw: input.text }, inline };
    const response = await this.fetchWithNetworkRetry(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      LogSink.error(`Failed to post comment: ${response.status} ${text}`, TraceTags.BITBUCKET);
    }
  }

  public async postGeneralComment(_project: string, slug: string, prId: number, text: string): Promise<number | null> {
    const url = `${API_BASE}/repositories/${this.workspace}/${slug}/pullrequests/${prId}/comments`;
    const response = await this.fetchWithNetworkRetry(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ content: { raw: text } }),
    });
    if (!response.ok) {
      const responseBody = await response.text();
      LogSink.error(`Failed to post general comment: ${response.status} ${responseBody}`, TraceTags.BITBUCKET);
      return null;
    }
    const json = (await response.json()) as { id?: number };
    return json.id ?? null;
  }

  public async replyToComment(
    _project: string,
    slug: string,
    prId: number,
    parentCommentId: number,
    text: string,
  ): Promise<void> {
    const url = `${API_BASE}/repositories/${this.workspace}/${slug}/pullrequests/${prId}/comments`;
    const response = await this.fetchWithNetworkRetry(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ content: { raw: text }, parent: { id: parentCommentId } }),
    });
    if (!response.ok) {
      const responseBody = await response.text();
      LogSink.error(
        `Failed to reply to comment ${parentCommentId}: ${response.status} ${responseBody}`,
        TraceTags.BITBUCKET,
      );
    }
  }

  public async updateComment(
    _project: string,
    slug: string,
    prId: number,
    commentId: number,
    text: string,
  ): Promise<void> {
    const url = `${API_BASE}/repositories/${this.workspace}/${slug}/pullrequests/${prId}/comments/${commentId}`;
    const response = await this.fetchWithNetworkRetry(url, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ content: { raw: text } }),
    });
    if (!response.ok) {
      const responseBody = await response.text();
      LogSink.error(`Failed to update comment ${commentId}: ${response.status} ${responseBody}`, TraceTags.BITBUCKET);
    }
  }

  // ── Build statuses ────────────────────────────────────────────────
  public async getBuildStatuses(_project: string, slug: string, commitId: string): Promise<IBuildStatus[]> {
    const wires = await this.fetchAllPages<ICloudBuildStatus>(
      `${API_BASE}/repositories/${this.workspace}/${slug}/commit/${commitId}/statuses`,
    );
    return wires.map(toBuildStatusCloud);
  }

  // ── Files ─────────────────────────────────────────────────────────
  public async getFileContent(
    _project: string,
    slug: string,
    filePath: string,
    opts?: { at?: string; quiet?: boolean },
  ): Promise<string | null> {
    const ref = opts?.at ?? 'HEAD';
    const url = `${API_BASE}/repositories/${this.workspace}/${slug}/src/${encodeURIComponent(ref)}/${filePath}`.replace(
      /%2F/g,
      '/',
    );
    if (!opts?.quiet) {
      LogSink.debug(`Bitbucket Cloud API: GET file ${filePath} (ref=${ref})`, TraceTags.BITBUCKET);
    }
    try {
      const response = await this.fetchWithNetworkRetry(url, {
        headers: { Authorization: this.authHeader },
      });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }
}
