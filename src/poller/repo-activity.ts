import type { IPullRequest } from '../provider/provider.types';

/** Ignore repos when neither the default branch nor any open PR has moved in this window. */
export const REPO_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True if we should poll the repo: default branch has a recent tip commit, unknown commit time,
 * or some open PR was created/updated within the window (or PR has no dates — do not skip).
 */
export function repoHasRecentActivity(
  defaultBranchCommitTs: number | null,
  prs: IPullRequest[],
  staleMs: number,
  now: number,
): boolean {
  const defaultRecent = defaultBranchCommitTs != null && now - defaultBranchCommitTs <= staleMs;
  const defaultUnknown = defaultBranchCommitTs == null;

  if (prs.length === 0) {
    return defaultRecent || defaultUnknown;
  }

  if (defaultRecent || defaultUnknown) {
    return true;
  }

  for (const pr of prs) {
    const u = pr.updatedAt;
    const c = pr.createdAt;
    if (u == null && c == null) {
      return true;
    }
    const last = Math.max(u ?? 0, c ?? 0);
    if (now - last <= staleMs) {
      return true;
    }
  }

  return false;
}
