import { isBotComment } from '../constants';

/**
 * Hidden marker appended to the bot's review-summary comment, recording which
 * source commit was reviewed. It lets a restarted daemon detect "I already
 * reviewed this commit" from the PR itself when its local state file is missing
 * or stale (e.g. killed mid-cycle before `state.json` was flushed) — a
 * remote-side backstop for the local `lastReviewedCommit` gate.
 */
export const reviewCommitMarker = (commit: string): string => `<!-- carrot-review commit=${commit} -->`;

/** True if a bot-authored comment already carries the review marker for `commit`. */
export const hasBotReviewForCommit = (
  comments: ReadonlyArray<{ text: string; authorUsername: string }>,
  botUsername: string,
  commit: string,
): boolean => {
  const marker = reviewCommitMarker(commit);
  return comments.some((c) => isBotComment(c.authorUsername, botUsername) && c.text.includes(marker));
};
