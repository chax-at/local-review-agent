export interface IPullRequest {
  id: number;
  title: string;
  draft: boolean;
  isOpen: boolean;
  /** Milliseconds since epoch, or null if the provider didn't return one. */
  createdAt: number | null;
  updatedAt: number | null;
  sourceBranch: string;
  sourceCommit: string;
  targetBranch: string;
  authorUsername: string;
}

export interface ICommentAuthor {
  username: string;
}

export interface ICommentAnchor {
  path: string;
  line: number;
}

export interface IComment {
  id: number;
  text: string;
  authorUsername: string;
  anchor?: ICommentAnchor;
  /** Direct child replies. Cloud and Server both flatten to one level here. */
  replies: Array<{ id: number; text: string; authorUsername: string }>;
}

export interface IActivity {
  /**
   * Monotonic, comparable id used by callers as a "have I seen this?" watermark.
   * Server: the activity record id. Cloud: the comment id (synthesised).
   */
  id: number;
  comment?: IComment;
}

export interface IInlineCommentInput {
  text: string;
  path: string;
  line: number;
  lineKind: 'added' | 'removed' | 'context';
  /** Original path for renamed files (DC-only field; Cloud ignores). */
  oldPath?: string;
  suggestion?: {
    replacement: string;
    startLine: number;
    endLine: number;
  };
}

export interface IBuildStatus {
  state: 'successful' | 'failed' | 'in_progress';
  url: string;
  key: string;
}

export interface IProject {
  key: string;
  name?: string;
}

export interface IRepo {
  slug: string;
  projectKey: string;
}

export interface IGitConfig {
  /** URL passed to `git clone` for a given (project, slug). */
  cloneUrlFor(project: string, slug: string): string;
  /** URL prefix that `http.<this>.extraheader` should match. Trailing slash matters. */
  authScopeUrl: string;
  /** Bearer token used by git over HTTPS. */
  token: string;
  /** When set, git uses HTTP Basic auth `{email}:{token}` instead of Bearer. */
  email?: string;
}
