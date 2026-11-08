// src/provider/forgejo/forgejo.mappers.ts
import type { IPullRequest, IComment, IBuildStatus, IRepo } from '../provider.types';
import type {
  IForgejoUser,
  IForgejoPullRequest,
  IForgejoIssueComment,
  IForgejoCommitStatus,
  ForgejoCommitStatusState,
  IForgejoRepository,
  IForgejoReviewComment,
  IForgejoReviewCommentInput,
} from './forgejo.types';

/** Login of a Forgejo user; '' for a missing (e.g. deleted) user. */
export function forgejoLogin(user: IForgejoUser | null | undefined): string {
  return user?.login ?? '';
}

const parseTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
};

export function toPullRequestForgejo(wire: IForgejoPullRequest): IPullRequest {
  return {
    id: wire.number,
    title: wire.title,
    description: wire.body ?? '',
    draft: wire.draft ?? false,
    isOpen: wire.state === 'open',
    createdAt: parseTime(wire.created_at),
    updatedAt: parseTime(wire.updated_at),
    sourceBranch: wire.head.ref,
    sourceCommit: wire.head.sha,
    targetBranch: wire.base.ref,
    authorUsername: forgejoLogin(wire.user),
    reviewerUsernames: (wire.requested_reviewers ?? []).map(forgejoLogin),
  };
}

const FORGEJO_BUILD_STATE_MAP: Record<ForgejoCommitStatusState, IBuildStatus['state']> = {
  success: 'successful',
  failure: 'failed',
  error: 'failed',
  pending: 'in_progress',
  warning: 'in_progress',
};

export function toBuildStatusForgejo(wire: IForgejoCommitStatus): IBuildStatus {
  return {
    state: FORGEJO_BUILD_STATE_MAP[wire.status] ?? 'in_progress',
    url: wire.target_url ?? '',
    key: wire.context ?? '',
  };
}

export function toRepoForgejo(wire: IForgejoRepository): IRepo {
  return { slug: wire.name, projectKey: wire.owner.login };
}

export function toIssueCommentForgejo(wire: IForgejoIssueComment): IComment {
  return {
    id: wire.id,
    text: wire.body,
    authorUsername: forgejoLogin(wire.user),
    replies: [],
  };
}

export type ForgejoSide = 'new' | 'old';

/** Where a code comment sits, and in which review: what a reply into its conversation needs. */
export interface IForgejoThreadAnchor {
  reviewId: number;
  path: string;
  side: ForgejoSide;
  line: number;
}

export interface IForgejoThreads {
  /** One IComment per conversation (parent with flattened replies). */
  comments: IComment[];
  /** Anchor of EVERY review comment id — parents and replies — for replyToComment. */
  anchors: Map<number, IForgejoThreadAnchor>;
}

export function toThreadAnchor(wire: IForgejoReviewComment): IForgejoThreadAnchor {
  const position = wire.position ?? 0;
  if (position > 0) {
    return { reviewId: wire.pull_request_review_id, path: wire.path, side: 'new', line: position };
  }
  return { reviewId: wire.pull_request_review_id, path: wire.path, side: 'old', line: wire.original_position ?? 0 };
}

/**
 * Forgejo shows one conversation per review and line (a second review on the
 * same line opens a separate box), so threads are keyed by review id, path,
 * side and line. The lowest id in a group is the parent; the rest become its
 * replies in id order.
 */
export function groupReviewComments(wires: IForgejoReviewComment[]): IForgejoThreads {
  const threads = new Map<string, IComment>();
  const anchors = new Map<number, IForgejoThreadAnchor>();
  const sorted = [...wires].sort((a, b) => a.id - b.id);
  for (const wire of sorted) {
    const anchor = toThreadAnchor(wire);
    anchors.set(wire.id, anchor);
    const key = JSON.stringify([anchor.reviewId, anchor.path, anchor.side, anchor.line]);
    const parent = threads.get(key);
    if (parent) {
      parent.replies.push({ id: wire.id, text: wire.body, authorUsername: forgejoLogin(wire.user) });
      continue;
    }
    threads.set(key, {
      id: wire.id,
      text: wire.body,
      authorUsername: forgejoLogin(wire.user),
      anchor: { path: anchor.path, line: anchor.line },
      replies: [],
    });
  }
  return { comments: [...threads.values()], anchors };
}

export function toReviewPositions(
  side: ForgejoSide,
  line: number,
): Pick<IForgejoReviewCommentInput, 'new_position' | 'old_position'> {
  if (side === 'new') return { new_position: line, old_position: 0 };
  return { new_position: 0, old_position: line };
}

/** Forgejo cannot apply ```suggestion blocks; label the block so readers know to apply it by hand. */
export function rewriteSuggestionFence(text: string): string {
  return text.replace('```suggestion\n', '**Suggested change** (apply by hand):\n\n```\n');
}

const QUOTE_MAX_CHARS = 200;

/** Zero-width space: put after an `@` so the text no longer pings anyone. */
const ZERO_WIDTH_SPACE = '\u200b';

/**
 * General-comment fallback for a reply: quote the parent's first line so the context is visible.
 * The quote must not re-ping the author or re-trigger the bot, so the author is shown in bold
 * without `@` and every `@` in the quoted line is neutralized.
 */
export function quoteReply(parent: Pick<IComment, 'text' | 'authorUsername'> | undefined, text: string): string {
  if (!parent) return text;
  const firstLine = parent.text
    .split('\n')[0]
    .replace(/\r$/, '')
    .slice(0, QUOTE_MAX_CHARS)
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`);
  const who = parent.authorUsername ? `**${parent.authorUsername}**: ` : '';
  return `> ${who}${firstLine}\n\n${text}`;
}
