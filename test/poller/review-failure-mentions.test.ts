import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { PollerService } from '../../src/poller/poller.service';
import type { IActivity } from '../../src/provider/provider.types';
import type { IPrState } from '../../src/types';

const pr = {
  id: 8,
  draft: false,
  authorUsername: 'human',
  sourceBranch: 'feature-8',
  sourceCommit: 'commit-8',
  targetBranch: 'main',
};

const mentionActivity = (id: number, text = '@bot explain this'): IActivity => ({
  id,
  comment: { id, text, authorUsername: 'human', replies: [] },
});

/** One configured repo with one never-reviewed PR, prReview on, state kept in a real map across cycles. */
const harness = (activities: IActivity[], reviewPr: ReturnType<typeof vi.fn>) => {
  const store = new Map<string, IPrState>();
  const provider = {
    listProjects: vi.fn().mockResolvedValue([{ key: 'P' }]),
    listRepos: vi.fn().mockResolvedValue([{ slug: 'r' }]),
    getOpenPullRequests: vi.fn().mockResolvedValue([pr]),
    getLatestCommitTimestampMs: vi.fn().mockResolvedValue(Date.now()),
    getActivities: vi.fn(async () => [...activities]),
    getComment: vi.fn().mockResolvedValue(null),
    getComments: vi.fn().mockResolvedValue([]),
    replyToComment: vi.fn().mockResolvedValue(undefined),
    postGeneralComment: vi.fn().mockResolvedValue(undefined),
  };
  const carrotConfig = {
    clearCache: vi.fn(),
    resetCycleCarrotGaps: vi.fn(),
    getCycleCarrotGaps: vi.fn().mockReturnValue({ missingFile: [], invalidFile: [] }),
    getConfig: vi.fn().mockResolvedValue({ prReview: true, rulesFiles: [], generateFixPrompts: false }),
  };
  const state = {
    pruneStale: vi.fn(),
    load: vi.fn(),
    save: vi.fn(),
    getPrState: vi.fn((repoKey: string, prId: string) => store.get(`${repoKey}#${prId}`)),
    setPrState: vi.fn((repoKey: string, prId: string, s: IPrState) => store.set(`${repoKey}#${prId}`, s)),
  };
  const router = {
    route: vi.fn().mockResolvedValue({ tool: 'ignore', message: '', reasoning: 'test' }),
    firstAvailableLlm: undefined,
  };
  const poller = new PollerService(
    provider as never,
    state as never,
    { reviewPr } as never,
    carrotConfig as never,
    { resetFetchMemo: vi.fn(), getFileFromBranch: vi.fn().mockReturnValue(null) } as never,
    router as never,
    'bot',
    1000,
    () => {},
  );
  const runCycle = (): Promise<void> => (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();
  const onItCommentIds = (): number[] =>
    provider.replyToComment.mock.calls.filter((c) => String(c[4]).includes('On it')).map((c) => c[3] as number);
  const prState = (): IPrState | undefined => store.get('P/r#8');
  return { provider, router, runCycle, onItCommentIds, prState };
};

describe('a failing auto-review keeps the mentions dispatched in the same cycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches mentions before the auto-review in a cycle', async () => {
    const reviewPr = vi.fn().mockRejectedValue(new Error('review boom'));
    const { provider, runCycle } = harness([mentionActivity(100)], reviewPr);

    await runCycle();

    expect(provider.replyToComment).toHaveBeenCalled();
    expect(provider.replyToComment.mock.invocationCallOrder[0]).toBeLessThan(reviewPr.mock.invocationCallOrder[0]);
  });

  it('does not dispatch the same mention again in the next cycle when the auto-review failed', async () => {
    const reviewPr = vi.fn().mockRejectedValue(new Error('review boom'));
    const { runCycle, onItCommentIds, prState } = harness([mentionActivity(100)], reviewPr);

    await runCycle();
    expect(onItCommentIds()).toEqual([100]);
    expect(prState()).toEqual(
      expect.objectContaining({
        lastReviewedCommit: '',
        lastActivityId: 100,
        processedMentionIds: [100],
        reviewFailures: 1,
      }),
    );

    await runCycle();

    expect(reviewPr).toHaveBeenCalledTimes(2);
    expect(onItCommentIds()).toEqual([100]);
    expect(prState()).toEqual(expect.objectContaining({ lastReviewedCommit: '', reviewFailures: 2 }));
  });

  it('still dispatches, in the next cycle, a mention that arrived after the scan of the failing cycle', async () => {
    const activities = [mentionActivity(100)];
    const reviewPr = vi.fn().mockImplementationOnce(async () => {
      // A user writes a new mention while the auto-review runs, then the review fails.
      activities.push(mentionActivity(101, '@bot and this too'));
      throw new Error('review boom');
    });
    reviewPr.mockRejectedValue(new Error('review boom'));
    const { runCycle, onItCommentIds, prState } = harness(activities, reviewPr);

    await runCycle();
    expect(onItCommentIds()).toEqual([100]);
    expect(prState()?.processedMentionIds).toEqual([100]);
    expect(prState()?.lastActivityId).toBe(100);

    await runCycle();

    expect(onItCommentIds()).toEqual([100, 101]);
    expect(prState()).toEqual(expect.objectContaining({ lastReviewedCommit: '', reviewFailures: 2 }));
  });
});
