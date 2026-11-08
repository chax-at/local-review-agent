// src/provider/forgejo/forgejo.client.ts
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
import { encodePath } from '../encode-path';
import {
  toPullRequestForgejo,
  toBuildStatusForgejo,
  toRepoForgejo,
  toIssueCommentForgejo,
  groupReviewComments,
  toReviewPositions,
  rewriteSuggestionFence,
  quoteReply,
  type IForgejoThreadAnchor,
} from './forgejo.mappers';
import type {
  IForgejoRepository,
  IForgejoBranch,
  IForgejoCommit,
  IForgejoPullRequest,
  IForgejoCommitStatus,
  IForgejoCreatePrPayload,
  IForgejoIssueComment,
  IForgejoReview,
  IForgejoTimelineEntry,
  IForgejoReviewComment,
  IForgejoCreateReviewPayload,
} from './forgejo.types';

/** Forgejo caps `limit` at the server's max_response_items (50 by default). */
const PAGE_LIMIT = 50;
/** Guard against a server that ignores `page`: never loop forever. */
const MAX_PAGES = 200;

/** Lookup tables of one PR, refreshed by every getComments call. */
interface IPrCommentIndex {
  /** Every code comment id (parents AND replies) → where a reply into its conversation goes. */
  anchors: Map<number, IForgejoThreadAnchor>;
  /** Every comment id → the comment. Thread parents carry their replies; a reply has `replies: []`. */
  byId: Map<number, IComment>;
  /** Review id → highest timeline entry id of type 'review' (created when the review is submitted). */
  reviewEntryIds: Map<number, number>;
}

export class ForgejoProvider implements IGitProvider {
  private readonly baseUrl: string;
  private readonly apiBase: string;
  private readonly token: string;
  /** `/user/repos` result, refreshed by every listProjects() (once per poll cycle). */
  private repoCache: IForgejoRepository[] | null = null;
  /** `${owner}/${slug}` of repos already warned about the branch-delete setting. */
  private readonly branchDeleteWarned = new Set<string>();

  /** Per-PR comment index, keyed by prKey(). */
  private readonly prComments = new Map<string, IPrCommentIndex>();

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiBase = `${this.baseUrl}/api/v1`;
    this.token = token;
  }

  public getGitConfig(): IGitConfig {
    const { baseUrl, token } = this;
    // No `email`: GitService then sends `Authorization: Bearer <token>`, which
    // Forgejo accepts for git over HTTPS (verified on a Forgejo instance).
    return {
      cloneUrlFor: (owner: string, slug: string): string => `${baseUrl}/${owner}/${slug}.git`,
      authScopeUrl: `${baseUrl}/`,
      token,
    };
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private repoPath(owner: string, slug: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
  }

  private prKey(owner: string, slug: string, prId: number): string {
    return `${owner}/${slug}#${prId}`;
  }

  /**
   * Retries network failures and 5xx responses with exponential back-off.
   * 4xx responses return immediately — those are real client errors.
   */
  private async fetchWithNetworkRetry(url: string, init?: RequestInit): Promise<Response> {
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === maxAttempts - 1) {
          LogSink.error(`Forgejo fetch failed after ${maxAttempts} attempts: ${msg}`, TraceTags.FORGEJO);
          throw err;
        }
        const waitMs = Math.pow(2, attempt) * 1000;
        LogSink.warn(
          `Forgejo fetch failed (${msg}), retry in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`,
          TraceTags.FORGEJO,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // `>=` (not `<`) so an undefined/NaN status from an incomplete mock never retries.
      if (!(response.status >= 500) || attempt === maxAttempts - 1) {
        return response;
      }
      const waitMs = Math.pow(2, attempt) * 1000;
      LogSink.warn(
        `Forgejo returned ${response.status}, retry in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`,
        TraceTags.FORGEJO,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
    throw new Error('Forgejo fetchWithNetworkRetry: unreachable');
  }

  /** One list request with 429 handling. Throws on a non-ok answer (auth errors as GitProviderAuthError). */
  private async fetchPage<T>(url: string): Promise<{ items: T[]; total: number | null }> {
    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
      if (response.status === 429) {
        const waitMs = Math.pow(2, attempt) * 5000;
        LogSink.warn(`Forgejo rate limited, waiting ${waitMs}ms (attempt ${attempt + 1}/3)...`, TraceTags.FORGEJO);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      const status = response?.status ?? 0;
      if (status === 401 || status === 403) {
        throw new GitProviderAuthError(`Forgejo auth failed (${status}). Check FORGEJO_TOKEN.`);
      }
      throw new Error(`Forgejo API error: ${status} for ${url}`);
    }

    const header = response.headers?.get('x-total-count');
    const total = header ? Number(header) : NaN;
    return { items: (await response.json()) as T[], total: Number.isFinite(total) ? total : null };
  }

  /**
   * Pages with `page`/`limit`. A short page does not prove the end (an admin can
   * set max_response_items below our limit), so stop on X-Total-Count, or on an
   * empty page when the header is missing.
   */
  private async fetchAllPages<T>(path: string): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?';
    const results: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items, total } = await this.fetchPage<T>(
        `${this.apiBase}${path}${separator}page=${page}&limit=${PAGE_LIMIT}`,
      );
      results.push(...items);
      if (items.length === 0 || (total !== null && results.length >= total)) {
        return results;
      }
    }
    LogSink.warn(`Forgejo: stopped paging ${path} after ${MAX_PAGES} pages`, TraceTags.FORGEJO);
    return results;
  }

  /** A list endpoint without paging (one request). */
  private async fetchList<T>(path: string): Promise<T[]> {
    return (await this.fetchPage<T>(`${this.apiBase}${path}`)).items;
  }

  /** GET one JSON object; null on any error. */
  private async getJson<T>(path: string): Promise<T | null> {
    try {
      const response = await this.fetchWithNetworkRetry(`${this.apiBase}${path}`, { headers: this.headers });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  // ── Discovery ─────────────────────────────────────────────────────
  /** Every owner (org or user) of a non-archived, non-mirror repo the bot can see is one "project". */
  public async listProjects(): Promise<IProject[]> {
    const repos = await this.fetchAllPages<IForgejoRepository>('/user/repos');
    this.repoCache = repos.filter((r) => !r.archived && !r.mirror);
    const owners = [...new Set(this.repoCache.map((r) => r.owner.login))];
    return owners.map((key) => ({ key, name: key }));
  }

  public async listRepos(projectKey: string): Promise<IRepo[]> {
    if (!this.repoCache) await this.listProjects();
    return (this.repoCache ?? []).filter((r) => r.owner.login === projectKey).map(toRepoForgejo);
  }

  public async listBranches(project: string, slug: string): Promise<string[]> {
    const branches = await this.fetchAllPages<IForgejoBranch>(`${this.repoPath(project, slug)}/branches`);
    return branches.map((b) => b.name);
  }

  public async getDefaultBranch(project: string, slug: string): Promise<string | null> {
    const repo = await this.getJson<IForgejoRepository>(this.repoPath(project, slug));
    return repo?.default_branch ?? null;
  }

  public async getBranchLatestCommit(project: string, slug: string, branch: string): Promise<string | null> {
    const data = await this.getJson<IForgejoBranch>(`${this.repoPath(project, slug)}/branches/${encodePath(branch)}`);
    return data?.commit?.id ?? null;
  }

  public async getLatestCommitTimestampMs(project: string, slug: string): Promise<number | null> {
    const commits = await this.getJson<IForgejoCommit[]>(
      `${this.repoPath(project, slug)}/commits?limit=1&stat=false&verification=false&files=false`,
    );
    const c = commits?.[0];
    if (!c) return null;
    const t = Date.parse(c.created ?? c.commit?.committer?.date ?? '');
    return Number.isNaN(t) ? null : t;
  }

  // ── Pull requests ─────────────────────────────────────────────────
  public async getOpenPullRequests(project: string, slug: string): Promise<IPullRequest[]> {
    const wires = await this.fetchAllPages<IForgejoPullRequest>(`${this.repoPath(project, slug)}/pulls?state=open`);
    return wires.map(toPullRequestForgejo);
  }

  public async getPullRequest(project: string, slug: string, prId: number): Promise<IPullRequest | null> {
    const url = `${this.apiBase}${this.repoPath(project, slug)}/pulls/${prId}`;
    const response = await this.fetchWithNetworkRetry(url, { headers: this.headers });
    if (!response.ok) {
      LogSink.warn(`Forgejo API: getPullRequest failed ${response.status}`, TraceTags.FORGEJO);
      return null;
    }
    return toPullRequestForgejo((await response.json()) as IForgejoPullRequest);
  }

  public async isPrOpen(project: string, slug: string, prId: number): Promise<boolean> {
    const pr = await this.getPullRequest(project, slug, prId);
    return pr?.isOpen === true;
  }

  /**
   * Forgejo cannot set "delete source branch on merge" per PR — only the repo
   * default exists. We never change repo settings; we warn once per repo instead.
   */
  public async createFixPr(
    project: string,
    slug: string,
    title: string,
    description: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<number> {
    const payload: IForgejoCreatePrPayload = { title, body: description, head: fromBranch, base: toBranch };
    const response = await this.fetchWithNetworkRetry(`${this.apiBase}${this.repoPath(project, slug)}/pulls`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to create PR: ${response.status} ${text}`);
    }
    const result = (await response.json()) as { number: number };
    await this.warnIfBranchDeleteOff(project, slug);
    return result.number;
  }

  private async warnIfBranchDeleteOff(owner: string, slug: string): Promise<void> {
    const key = `${owner}/${slug}`;
    if (this.branchDeleteWarned.has(key)) return;
    const repo = await this.getJson<IForgejoRepository>(this.repoPath(owner, slug));
    if (repo?.default_delete_branch_after_merge !== false) return;
    this.branchDeleteWarned.add(key);
    LogSink.warn(
      `Forgejo repo ${key}: "Delete pull request branch after merge by default" is off — carrot branches will stay after merge`,
      TraceTags.FORGEJO,
    );
  }

  // ── Comments / activities ─────────────────────────────────────────
  /**
   * General comments plus every review's code comments. Both kinds share one
   * id sequence in Forgejo, so ids stay a valid "seen" watermark. A review's
   * summary text is not read (known limit).
   */
  public async getComments(project: string, slug: string, prId: number): Promise<IComment[]> {
    const repo = this.repoPath(project, slug);
    const issueWires = await this.fetchList<IForgejoIssueComment>(`${repo}/issues/${prId}/comments`);
    const timeline = await this.fetchAllPages<IForgejoTimelineEntry>(`${repo}/issues/${prId}/timeline`);
    const reviews = await this.fetchAllPages<IForgejoReview>(`${repo}/pulls/${prId}/reviews`);
    const reviewWires: IForgejoReviewComment[] = [];
    for (const review of reviews) {
      if (review.comments_count === 0) continue;
      reviewWires.push(
        ...(await this.fetchList<IForgejoReviewComment>(`${repo}/pulls/${prId}/reviews/${review.id}/comments`)),
      );
    }

    const threads = groupReviewComments(reviewWires);
    const all = [...issueWires.map(toIssueCommentForgejo), ...threads.comments].sort((a, b) => a.id - b.id);

    const byId = new Map<number, IComment>();
    for (const comment of all) {
      byId.set(comment.id, comment);
      for (const reply of comment.replies) byId.set(reply.id, { ...reply, replies: [] });
    }
    const reviewEntryIds = new Map<number, number>();
    for (const entry of timeline) {
      if (entry.type !== 'review' || typeof entry.review_id !== 'number') continue;
      reviewEntryIds.set(entry.review_id, Math.max(entry.id, reviewEntryIds.get(entry.review_id) ?? 0));
    }
    this.prComments.set(this.prKey(project, slug, prId), { anchors: threads.anchors, byId, reviewEntryIds });
    return all;
  }

  /**
   * A code comment drafted in a pending review gets its id when drafted, but is
   * visible only after the review is submitted. The activity id of a code thread
   * is therefore raised to the id of its review's submit entry in the timeline,
   * so the poller's watermark cannot pass a draft that is still hidden.
   */
  public async getActivities(project: string, slug: string, prId: number): Promise<IActivity[]> {
    const comments = await this.getComments(project, slug, prId);
    const index = this.prComments.get(this.prKey(project, slug, prId));
    return comments.map((c) => {
      const anchor = index?.anchors.get(c.id);
      const submitId = anchor ? (index?.reviewEntryIds.get(anchor.reviewId) ?? 0) : 0;
      return { id: Math.max(c.id, submitId), comment: c };
    });
  }

  /**
   * A reply id returns the reply alone (`replies: []`), like Cloud. Returning the
   * whole thread would make the poller think the bot already answered a newer
   * mention in the same thread.
   */
  public async getComment(project: string, slug: string, prId: number, commentId: number): Promise<IComment | null> {
    try {
      await this.getComments(project, slug, prId);
    } catch {
      return null;
    }
    return this.prComments.get(this.prKey(project, slug, prId))?.byId.get(commentId) ?? null;
  }

  /** Forgejo posts code comments only inside a review: one COMMENT review per call. */
  public async postInlineComment(
    project: string,
    slug: string,
    prId: number,
    input: IInlineCommentInput,
  ): Promise<void> {
    const side = input.lineKind === 'removed' ? 'old' : 'new';
    const body = input.suggestion ? rewriteSuggestionFence(input.text) : input.text;
    const payload: IForgejoCreateReviewPayload = {
      event: 'COMMENT',
      body: '',
      comments: [{ path: input.path, body, ...toReviewPositions(side, input.line) }],
    };
    const response = await this.fetchWithNetworkRetry(
      `${this.apiBase}${this.repoPath(project, slug)}/pulls/${prId}/reviews`,
      { method: 'POST', headers: this.headers, body: JSON.stringify(payload) },
    );
    if (!response.ok) {
      const text = await response.text();
      LogSink.error(`Failed to post comment: ${response.status} ${text}`, TraceTags.FORGEJO);
    }
  }

  public async postGeneralComment(project: string, slug: string, prId: number, text: string): Promise<number | null> {
    const response = await this.fetchWithNetworkRetry(
      `${this.apiBase}${this.repoPath(project, slug)}/issues/${prId}/comments`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ body: text }) },
    );
    if (!response.ok) {
      const responseBody = await response.text();
      LogSink.error(`Failed to post general comment: ${response.status} ${responseBody}`, TraceTags.FORGEJO);
      return null;
    }
    const json = (await response.json()) as { id?: number };
    return json.id ?? null;
  }

  /**
   * Forgejo has no reply endpoint. A comment added to the parent's review on the
   * same path and line joins the parent's conversation (verified on
   * a Forgejo instance); a separate review would open a new box. General comments,
   * and any failure, fall back to a general comment that quotes the parent.
   */
  public async replyToComment(
    project: string,
    slug: string,
    prId: number,
    parentCommentId: number,
    text: string,
  ): Promise<void> {
    const key = this.prKey(project, slug, prId);
    if (!this.prComments.get(key)?.byId.has(parentCommentId)) {
      try {
        await this.getComments(project, slug, prId);
      } catch (err) {
        LogSink.warn(`Forgejo: could not load PR #${prId} comments for a reply: ${err}`, TraceTags.FORGEJO);
      }
    }
    const index = this.prComments.get(key);
    const anchor = index?.anchors.get(parentCommentId);
    if (anchor && (await this.postIntoReview(project, slug, prId, anchor, text))) return;
    await this.postGeneralComment(project, slug, prId, quoteReply(index?.byId.get(parentCommentId), text));
  }

  private async postIntoReview(
    project: string,
    slug: string,
    prId: number,
    anchor: IForgejoThreadAnchor,
    text: string,
  ): Promise<boolean> {
    const url = `${this.apiBase}${this.repoPath(project, slug)}/pulls/${prId}/reviews/${anchor.reviewId}/comments`;
    try {
      const response = await this.fetchWithNetworkRetry(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ path: anchor.path, body: text, ...toReviewPositions(anchor.side, anchor.line) }),
      });
      if (response.ok) return true;
      const responseBody = await response.text();
      LogSink.warn(
        `Forgejo: reply into review ${anchor.reviewId} failed (${response.status} ${responseBody}), posting a general comment instead`,
        TraceTags.FORGEJO,
      );
    } catch (err) {
      LogSink.warn(
        `Forgejo: reply into review ${anchor.reviewId} failed (${err}), posting a general comment instead`,
        TraceTags.FORGEJO,
      );
    }
    return false;
  }

  public async updateComment(
    project: string,
    slug: string,
    _prId: number,
    commentId: number,
    text: string,
  ): Promise<void> {
    const response = await this.fetchWithNetworkRetry(
      `${this.apiBase}${this.repoPath(project, slug)}/issues/comments/${commentId}`,
      { method: 'PATCH', headers: this.headers, body: JSON.stringify({ body: text }) },
    );
    if (!response.ok) {
      const responseBody = await response.text();
      LogSink.error(`Failed to update comment ${commentId}: ${response.status} ${responseBody}`, TraceTags.FORGEJO);
    }
  }

  // ── Build statuses ────────────────────────────────────────────────
  public async getBuildStatuses(project: string, slug: string, commitId: string): Promise<IBuildStatus[]> {
    const wires = await this.fetchAllPages<IForgejoCommitStatus>(
      `${this.repoPath(project, slug)}/commits/${encodeURIComponent(commitId)}/statuses`,
    );
    return wires.map(toBuildStatusForgejo);
  }

  // ── Files ─────────────────────────────────────────────────────────
  public async getFileContent(
    project: string,
    slug: string,
    filePath: string,
    opts?: { at?: string; quiet?: boolean },
  ): Promise<string | null> {
    const ref = opts?.at ? `?ref=${encodeURIComponent(opts.at)}` : '';
    const url = `${this.apiBase}${this.repoPath(project, slug)}/raw/${encodePath(filePath)}${ref}`;
    if (!opts?.quiet) {
      LogSink.debug(`Forgejo API: GET file ${filePath} (ref=${opts?.at ?? 'default'})`, TraceTags.FORGEJO);
    }
    try {
      const response = await this.fetchWithNetworkRetry(url, { headers: { Authorization: `token ${this.token}` } });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }
}
