import { describe, it, expect } from 'vitest';
import { repoHasRecentActivity, REPO_ACTIVITY_WINDOW_MS } from '../../src/poller/repo-activity';
import type { IPullRequest } from '../../src/provider/provider.types';

const now = 1_000_000_000_000; // fixed epoch ms
const staleMs = REPO_ACTIVITY_WINDOW_MS;

function pr(partial: Partial<IPullRequest> & Pick<IPullRequest, 'id'>): IPullRequest {
  return {
    id: partial.id,
    title: partial.title ?? 't',
    draft: partial.draft ?? false,
    isOpen: partial.isOpen ?? true,
    sourceBranch: partial.sourceBranch ?? 'feat',
    sourceCommit: partial.sourceCommit ?? 'h',
    targetBranch: partial.targetBranch ?? 'main',
    authorUsername: partial.authorUsername ?? 'dev',
    createdAt: partial.createdAt ?? null,
    updatedAt: partial.updatedAt ?? null,
  };
}

describe('repoHasRecentActivity', () => {
  it('returns false for no PRs and default branch older than window', () => {
    const old = now - staleMs - 1;
    expect(repoHasRecentActivity(old, [], staleMs, now)).toBe(false);
  });

  it('returns true for no PRs and default branch inside window', () => {
    const recent = now - staleMs + 1;
    expect(repoHasRecentActivity(recent, [], staleMs, now)).toBe(true);
  });

  it('returns true for no PRs when commit time is unknown', () => {
    expect(repoHasRecentActivity(null, [], staleMs, now)).toBe(true);
  });

  it('returns true when default is stale but a PR was updated recently', () => {
    const old = now - staleMs - 1;
    const prs = [pr({ id: 1, updatedAt: now - 1000 })];
    expect(repoHasRecentActivity(old, prs, staleMs, now)).toBe(true);
  });

  it('returns false when default and all PRs are older than window', () => {
    const old = now - staleMs - 1;
    const prs = [pr({ id: 1, createdAt: now - staleMs - 2, updatedAt: now - staleMs - 2 })];
    expect(repoHasRecentActivity(old, prs, staleMs, now)).toBe(false);
  });

  it('returns true when PR has no timestamps (do not skip)', () => {
    const old = now - staleMs - 1;
    const prs = [pr({ id: 1 })];
    expect(repoHasRecentActivity(old, prs, staleMs, now)).toBe(true);
  });
});
