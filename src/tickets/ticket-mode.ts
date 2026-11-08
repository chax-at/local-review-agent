import { commentMentionsBot, isSameJiraUser, type IJiraRawComment, type IJiraUser } from '../jira/jira-identity';
import type { IJiraIssueForRun } from '../jira/jira.service';
import type { ITicketState } from '../types';

export type TicketMode =
  | { kind: 'continue'; mention: IJiraRawComment }
  | { kind: 'fresh' }
  | { kind: 'skip'; reason: string };

export function newestCommentId(comments: IJiraRawComment[]): number {
  return comments.reduce((max, c) => Math.max(max, c.id), 0);
}

/**
 * Newest comment above the watermark, written by a person (never the bot),
 * that mentions the bot. The bot's own result comments contain "@carrot" as
 * text, so excluding bot authors is what keeps this from self-triggering.
 * `comments` must be ascending by id (as `parseRawComments` returns them);
 * the scan stops at the first id at or below the watermark.
 */
export function findNewMention(
  comments: IJiraRawComment[],
  lastCommentId: number,
  bot: IJiraUser,
): IJiraRawComment | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.id <= lastCommentId) break;
    if (isSameJiraUser(c.author, bot)) continue;
    if (commentMentionsBot(c, bot)) return c;
  }
  return null;
}

/**
 * Spec section 1, "Run modes":
 *  - a new mention → continue;
 *  - no state, or the assignment is newer than the last run → fresh;
 *  - otherwise skip (this assignment was already handled).
 * A missing assignment in the changelog counts as newer than any run.
 */
export function decideTicketMode(input: {
  issue: Pick<IJiraIssueForRun, 'comments' | 'assignment'>;
  state: ITicketState | undefined;
  bot: IJiraUser;
}): TicketMode {
  const { issue, state, bot } = input;
  const mention = findNewMention(issue.comments, state?.lastCommentId ?? 0, bot);
  if (mention) return { kind: 'continue', mention };
  if (!state) return { kind: 'fresh' };
  // A failed run is retried next cycle while the ticket stays assigned; the
  // hand-back at the attempt cap resets attempts to 0.
  if (state.attempts > 0) return { kind: 'fresh' };

  const assignedAt = issue.assignment ? Date.parse(issue.assignment.assignedAt) : Number.POSITIVE_INFINITY;
  const lastRunAt = Date.parse(state.lastRunAt);
  if (Number.isNaN(lastRunAt) || Number.isNaN(assignedAt) || assignedAt > lastRunAt) return { kind: 'fresh' };

  return { kind: 'skip', reason: 'assignment already handled; waiting for a mention or a new assignment' };
}
