import type {
  IPullRequest,
  IComment,
  IActivity,
  IInlineCommentInput,
  IBuildStatus,
  IProject,
  IRepo,
  IGitConfig,
} from './provider.types';

export { IPullRequest, IComment, IActivity, IInlineCommentInput, IBuildStatus, IProject, IRepo, IGitConfig };
export type { ICommentAnchor, ICommentAuthor } from './provider.types';

export class GitProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitProviderAuthError';
  }
}

export interface IGitProvider {
  // ── Discovery ─────────────────────────────────────────────────────
  listProjects(): Promise<IProject[]>;
  listRepos(projectKey: string): Promise<IRepo[]>;
  listBranches(project: string, slug: string): Promise<string[]>;
  getBranchLatestCommit(project: string, slug: string, branch: string): Promise<string | null>;
  getLatestCommitTimestampMs(project: string, slug: string): Promise<number | null>;

  // ── Pull requests ─────────────────────────────────────────────────
  getOpenPullRequests(project: string, slug: string): Promise<IPullRequest[]>;
  getPullRequest(project: string, slug: string, prId: number): Promise<IPullRequest | null>;
  isPrOpen(project: string, slug: string, prId: number): Promise<boolean>;
  /** Creates the PR AND configures it to delete the source branch on merge. */
  createFixPr(
    project: string,
    slug: string,
    title: string,
    description: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<number>;

  // ── Comments / activities ─────────────────────────────────────────
  getActivities(project: string, slug: string, prId: number): Promise<IActivity[]>;
  getComments(project: string, slug: string, prId: number): Promise<IComment[]>;
  getComment(project: string, slug: string, prId: number, commentId: number): Promise<IComment | null>;
  postInlineComment(project: string, slug: string, prId: number, input: IInlineCommentInput): Promise<void>;
  postGeneralComment(project: string, slug: string, prId: number, text: string): Promise<number | null>;
  replyToComment(project: string, slug: string, prId: number, parentCommentId: number, text: string): Promise<void>;
  updateComment(project: string, slug: string, prId: number, commentId: number, text: string): Promise<void>;

  // ── Build statuses ────────────────────────────────────────────────
  getBuildStatuses(project: string, slug: string, commitId: string): Promise<IBuildStatus[]>;

  // ── Files ─────────────────────────────────────────────────────────
  getFileContent(
    project: string,
    slug: string,
    filePath: string,
    opts?: { at?: string; quiet?: boolean },
  ): Promise<string | null>;

  // ── Git integration ───────────────────────────────────────────────
  getGitConfig(): IGitConfig;
}
