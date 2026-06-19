export interface IReviewFinding {
  filePath: string;
  line: number;
  severity: 'concern' | 'suggestion' | 'note';
  comment: string;
}

/** A review finding tagged with the model (Name) that produced it. */
export interface IAuthoredFinding extends IReviewFinding {
  author: string;
  /** The review role (persona) that produced this finding, e.g. "security". */
  persona?: string;
  /**
   * Set only when this finding is the product of merging duplicate findings
   * (see FindingDeduplicator): every model whose finding contributed. The
   * validation council excludes all contributors from voting on it, so a model
   * that produced one half of a merged finding can't rubber-stamp it.
   */
  contributingAuthors?: string[];
}

export interface IPrState {
  /** Empty string while auto-review attempts are still failing (PR seen but not yet reviewed). */
  lastReviewedCommit: string;
  lastCheckedAt: string;
  lastActivityId: number;
  /** Comment IDs already processed for @mentions (prevents reprocessing on restart) */
  processedMentionIds?: number[];
  /**
   * Consecutive auto-review failures for this PR. Once it reaches the poller's
   * retry cap, auto-review stops retrying (each retry costs a full review's
   * LLM spend) — an explicit @mention review still works.
   */
  reviewFailures?: number;
}

export interface IAppState {
  repos: Partial<
    Record<
      string,
      {
        pullRequests: Partial<Record<string, IPrState>>;
      }
    >
  >;
}

export interface IDiffChunk {
  filePath: string;
  oldPath?: string;
  content: string;
  lineCount: number;
}

export type MentionTool = 'fix' | 'autofix' | 'revert' | 'review' | 'audit_fix' | 'explain' | 'reply' | 'ignore';

export interface IMentionCommand {
  type: MentionTool;
  message: string; // always set — router reformulates intent
  reasoning?: string; // logged, not shown to user
  prId: number;
  repoKey: string;
  commentId?: number;
  /** Anchor info from the comment (for context gathering) */
  anchorFile?: string;
  anchorLine?: number;
  /** Sibling replies in the thread (for context) */
  siblingReplies?: string[];
}

export type BambooBuildStatus = 'checked_ok' | 'audit_detected' | 'fix_applied';

export interface IBambooBuildState {
  checkedAt: string;
  state: string;
  auditIssue: boolean;
  prProject?: string;
  prSlug?: string;
  prId?: number;
  prBranch?: string;
  status: BambooBuildStatus;
  vulnerabilities?: unknown[];
}

export interface IAuditPrTracker {
  /** The audit branch name (e.g. "audit/2026.03.22-19.30") */
  auditBranch: string;
  /** Bitbucket PR ID */
  prId: number;
  /** Target branch this audit PR merges into */
  targetBranch: string;
  /** Project key */
  project: string;
  /** Repo slug */
  slug: string;
  /** When the audit PR was created or last updated */
  lastUpdated: string;
}

export interface IBambooState {
  builds: Record<string, IBambooBuildState>;
  /** Open audit fix PRs, keyed by "PROJECT/slug:targetBranch" */
  auditPrs?: Record<string, IAuditPrTracker>;
  /** Last scheduled audit check per "PROJECT/slug:branch" */
  scheduledAudits?: Record<string, string>;
}

export interface IModelUsage {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  costEur: number;
}
