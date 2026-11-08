// src/provider/forgejo/forgejo.types.ts
// Forgejo (Gitea-compatible) API v1 wire types. Only the fields carrot reads or sends.

export interface IForgejoUser {
  login: string;
}

export interface IForgejoRepository {
  name: string;
  owner: IForgejoUser;
  archived?: boolean;
  mirror?: boolean;
  default_branch?: string;
  default_delete_branch_after_merge?: boolean;
}

/** One entry of GET /repos/{o}/{r}/issues/{n}/timeline (only the fields carrot reads). */
export interface IForgejoTimelineEntry {
  id: number;
  type: string;
  review_id?: number | null;
}

export interface IForgejoBranch {
  name: string;
  commit?: { id?: string };
}

export interface IForgejoCommit {
  sha: string;
  created?: string;
  commit?: { committer?: { date?: string } };
}

export interface IForgejoPullRequest {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  user?: IForgejoUser | null;
  requested_reviewers?: IForgejoUser[] | null;
}

/** A general (issue) comment on the PR conversation. */
export interface IForgejoIssueComment {
  id: number;
  body: string;
  user?: IForgejoUser | null;
}

export interface IForgejoReview {
  id: number;
  comments_count?: number;
}

/**
 * A code comment inside a review. `position` is the new-side file line and
 * `original_position` the old-side file line; the other one is 0.
 */
export interface IForgejoReviewComment {
  id: number;
  body: string;
  user?: IForgejoUser | null;
  path: string;
  position?: number | null;
  original_position?: number | null;
  pull_request_review_id: number;
}

export type ForgejoCommitStatusState = 'pending' | 'success' | 'error' | 'failure' | 'warning';

export interface IForgejoCommitStatus {
  status: ForgejoCommitStatusState;
  target_url?: string;
  context?: string;
}

export interface IForgejoCreatePrPayload {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface IForgejoReviewCommentInput {
  path: string;
  body: string;
  new_position: number;
  old_position: number;
}

export interface IForgejoCreateReviewPayload {
  event: 'COMMENT';
  body: string;
  comments: IForgejoReviewCommentInput[];
}
