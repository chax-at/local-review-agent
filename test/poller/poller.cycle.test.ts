import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs so pollCycle's temp-dir cleanup doesn't touch
// the real filesystem (cleanupTempDir would wipe the live /tmp/carrot dir).
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { PollerService } from '../../src/poller/poller.service';

describe('poll cycle fetch-memo wiring', () => {
  let git: { resetFetchMemo: ReturnType<typeof vi.fn> };
  let provider: { listProjects: ReturnType<typeof vi.fn> };
  let state: {
    pruneStale: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  };
  let carrotConfig: {
    clearCache: ReturnType<typeof vi.fn>;
    resetCycleCarrotGaps: ReturnType<typeof vi.fn>;
    getCycleCarrotGaps: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    git = { resetFetchMemo: vi.fn() };
    provider = { listProjects: vi.fn().mockResolvedValue([]) };
    state = { pruneStale: vi.fn(), save: vi.fn(), load: vi.fn() };
    carrotConfig = {
      clearCache: vi.fn(),
      resetCycleCarrotGaps: vi.fn(),
      getCycleCarrotGaps: vi.fn().mockReturnValue({ missingFile: [], invalidFile: [] }),
    };
  });

  it('PollerService.pollCycle clears the git fetch memo before polling', async () => {
    const poller = new PollerService(
      provider as never,
      state as never,
      {} as never, // reviewer — unused with no projects
      carrotConfig as never,
      git as never,
      {} as never, // router — unused with no projects
      'bot',
      1000,
      () => {},
    );
    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();
    expect(git.resetFetchMemo).toHaveBeenCalled();
    expect(git.resetFetchMemo.mock.invocationCallOrder[0]).toBeLessThan(
      provider.listProjects.mock.invocationCallOrder[0],
    );
  });

  it('runs the ticket phase before PR discovery', async () => {
    const ticketService = { pollTickets: vi.fn().mockResolvedValue(undefined) };
    const poller = new PollerService(
      provider as never,
      state as never,
      {} as never,
      carrotConfig as never,
      git as never,
      {} as never,
      'bot',
      1000,
      () => {},
      ticketService,
    );
    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();
    expect(ticketService.pollTickets).toHaveBeenCalledTimes(1);
    expect(ticketService.pollTickets.mock.invocationCallOrder[0]).toBeLessThan(
      provider.listProjects.mock.invocationCallOrder[0],
    );
  });

  it('a throwing ticket phase does not stop the PR phase', async () => {
    const ticketService = { pollTickets: vi.fn().mockRejectedValue(new Error('jira down')) };
    const poller = new PollerService(
      provider as never,
      state as never,
      {} as never,
      carrotConfig as never,
      git as never,
      {} as never,
      'bot',
      1000,
      () => {},
      ticketService,
    );
    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();
    expect(provider.listProjects).toHaveBeenCalled();
  });
});

describe('poll cycle persists review state per PR (survives mid-cycle kill)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves state after each reviewed PR, not only once at cycle end', async () => {
    const now = Date.now();
    const mkPr = (id: number) => ({
      id,
      draft: false,
      authorUsername: 'human',
      sourceBranch: `feature-${id}`,
      sourceCommit: `commit-${id}`,
      targetBranch: 'main',
    });

    const git = { resetFetchMemo: vi.fn() };
    const reviewer = { reviewPr: vi.fn().mockResolvedValue(undefined) };
    const provider = {
      listProjects: vi.fn().mockResolvedValue([{ key: 'P' }]),
      listRepos: vi.fn().mockResolvedValue([{ slug: 'r' }]),
      getOpenPullRequests: vi.fn().mockResolvedValue([mkPr(1), mkPr(2), mkPr(3)]),
      getLatestCommitTimestampMs: vi.fn().mockResolvedValue(now),
      getActivities: vi.fn().mockResolvedValue([]),
    };
    const carrotConfig = {
      clearCache: vi.fn(),
      resetCycleCarrotGaps: vi.fn(),
      getCycleCarrotGaps: vi.fn().mockReturnValue({ missingFile: [], invalidFile: [] }),
      getConfig: vi.fn().mockResolvedValue({
        prReview: true,
        rulesFiles: [],
        generateFixPrompts: false,
      }),
    };
    const state = {
      pruneStale: vi.fn(),
      load: vi.fn(),
      save: vi.fn(),
      getPrState: vi.fn().mockReturnValue(undefined),
      setPrState: vi.fn(),
    };

    const poller = new PollerService(
      provider as never,
      state as never,
      reviewer as never,
      carrotConfig as never,
      git as never,
      {} as never, // router
      'bot',
      1000,
      () => {},
    );

    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();

    // 3 PRs reviewed → state must be flushed to disk at least once per PR, so a
    // kill after PR #1 still durably records that PR #1 was reviewed.
    expect(reviewer.reviewPr).toHaveBeenCalledTimes(3);
    expect(state.save.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('draft PRs: mentions work, auto-review does not', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not auto-review a draft PR even when prReview is enabled and it has never been reviewed', async () => {
    const now = Date.now();
    const draftPr = {
      id: 9,
      draft: true,
      authorUsername: 'human',
      sourceBranch: 'feature-9',
      sourceCommit: 'commit-9',
      targetBranch: 'main',
    };

    const git = { resetFetchMemo: vi.fn() };
    const reviewer = { reviewPr: vi.fn().mockResolvedValue(undefined) };
    const provider = {
      listProjects: vi.fn().mockResolvedValue([{ key: 'P' }]),
      listRepos: vi.fn().mockResolvedValue([{ slug: 'r' }]),
      getOpenPullRequests: vi.fn().mockResolvedValue([draftPr]),
      getLatestCommitTimestampMs: vi.fn().mockResolvedValue(now),
      getActivities: vi.fn().mockResolvedValue([]),
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
      getPrState: vi.fn().mockReturnValue(undefined),
      setPrState: vi.fn(),
    };

    const poller = new PollerService(
      provider as never,
      state as never,
      reviewer as never,
      carrotConfig as never,
      git as never,
      {} as never, // router — no mention to route in this test
      'bot',
      1000,
      () => {},
    );

    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();

    // The draft must still enter the per-PR loop (so mentions can reach it)...
    expect(state.getPrState).toHaveBeenCalledWith('P/r', '9');
    // ...but auto-review must never fire for it.
    expect(reviewer.reviewPr).not.toHaveBeenCalled();
  });

  it('lets an explicit @mention trigger a review on a draft PR, without also auto-reviewing it', async () => {
    const now = Date.now();
    const draftPr = {
      id: 7,
      draft: true,
      authorUsername: 'human',
      sourceBranch: 'feature-7',
      sourceCommit: 'commit-7',
      targetBranch: 'main',
    };
    const mentionComment = {
      id: 501,
      text: '@bot review this',
      authorUsername: 'human',
      replies: [],
    };

    const git = { resetFetchMemo: vi.fn(), getFileFromBranch: vi.fn() };
    const reviewer = { reviewPr: vi.fn().mockResolvedValue(undefined) };
    const provider = {
      listProjects: vi.fn().mockResolvedValue([{ key: 'P' }]),
      listRepos: vi.fn().mockResolvedValue([{ slug: 'r' }]),
      getOpenPullRequests: vi.fn().mockResolvedValue([draftPr]),
      getLatestCommitTimestampMs: vi.fn().mockResolvedValue(now),
      getActivities: vi.fn().mockResolvedValue([{ id: 1, comment: mentionComment }]),
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
      getPrState: vi.fn().mockReturnValue(undefined),
      setPrState: vi.fn(),
    };
    const router = {
      route: vi.fn().mockResolvedValue({ tool: 'review', message: 'review this PR', reasoning: 'user asked' }),
      firstAvailableLlm: undefined,
    };

    const poller = new PollerService(
      provider as never,
      state as never,
      reviewer as never,
      carrotConfig as never,
      git as never,
      router as never,
      'bot',
      1000,
      () => {},
    );

    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();

    // Exactly one call: the mention's 'review' tool fires it. If the draft
    // guard were missing, auto-review (prReview:true, never reviewed) would
    // ALSO fire, making this 2 — so this assertion catches both regressions.
    expect(reviewer.reviewPr).toHaveBeenCalledTimes(1);
    expect(provider.replyToComment).toHaveBeenCalledWith('P', 'r', 7, 501, expect.stringContaining('On it'));
  });
});

describe('draft PR later marked ready still gets auto-reviewed (regression)', () => {
  it('does not mark a draft PR as reviewed, so auto-review fires once it becomes ready', async () => {
    const now = Date.now();
    const draftPr = {
      id: 11,
      draft: true,
      authorUsername: 'human',
      sourceBranch: 'feature-11',
      sourceCommit: 'commit-11',
      targetBranch: 'main',
    };
    const readyPr = { ...draftPr, draft: false };

    const git = { resetFetchMemo: vi.fn() };
    const reviewer = { reviewPr: vi.fn().mockResolvedValue(undefined) };

    // A tiny in-memory store standing in for StateService, so cycle 2 reads
    // back exactly what cycle 1 persisted — this is the actual bug's
    // mechanism, not just an isolated assertion on one cycle's call args.
    const store = new Map<string, any>();
    const state = {
      pruneStale: vi.fn(),
      load: vi.fn(),
      save: vi.fn(),
      getPrState: vi.fn((repoKey: string, prIdStr: string) => store.get(`${repoKey}/${prIdStr}`)),
      setPrState: vi.fn((repoKey: string, prIdStr: string, s: any) => store.set(`${repoKey}/${prIdStr}`, s)),
    };
    const carrotConfig = {
      clearCache: vi.fn(),
      resetCycleCarrotGaps: vi.fn(),
      getCycleCarrotGaps: vi.fn().mockReturnValue({ missingFile: [], invalidFile: [] }),
      getConfig: vi.fn().mockResolvedValue({ prReview: true, rulesFiles: [], generateFixPrompts: false }),
    };
    const provider = {
      listProjects: vi.fn().mockResolvedValue([{ key: 'P' }]),
      listRepos: vi.fn().mockResolvedValue([{ slug: 'r' }]),
      getOpenPullRequests: vi.fn(),
      getLatestCommitTimestampMs: vi.fn().mockResolvedValue(now),
      getActivities: vi.fn().mockResolvedValue([]),
    };

    const poller = new PollerService(
      provider as never,
      state as never,
      reviewer as never,
      carrotConfig as never,
      git as never,
      {} as never, // router
      'bot',
      1000,
      () => {},
    );

    // Cycle 1: the PR is a draft. Auto-review must be skipped, and the
    // persisted state must NOT mark it as reviewed.
    provider.getOpenPullRequests.mockResolvedValueOnce([draftPr]);
    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();
    expect(reviewer.reviewPr).not.toHaveBeenCalled();
    expect(store.get('P/r/11')?.lastReviewedCommit).toBe('');

    // Cycle 2: the same PR is now marked ready, same commit. Auto-review
    // must fire — before the fix, cycle 1 would have already stamped
    // lastReviewedCommit as the commit SHA, permanently suppressing this.
    provider.getOpenPullRequests.mockResolvedValueOnce([readyPr]);
    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();
    expect(reviewer.reviewPr).toHaveBeenCalledTimes(1);
  });
});

describe('bot listed as PR reviewer triggers auto-review even with no config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function basePoller(opts: { prs: any[]; getConfig: ReturnType<typeof vi.fn>; reviewPr?: ReturnType<typeof vi.fn> }) {
    const git = { resetFetchMemo: vi.fn() };
    const reviewer = { reviewPr: opts.reviewPr ?? vi.fn().mockResolvedValue(undefined) };
    const provider = {
      listProjects: vi.fn().mockResolvedValue([{ key: 'P' }]),
      listRepos: vi.fn().mockResolvedValue([{ slug: 'r' }]),
      getOpenPullRequests: vi.fn().mockResolvedValue(opts.prs),
      getLatestCommitTimestampMs: vi.fn().mockResolvedValue(Date.now()),
      getActivities: vi.fn().mockResolvedValue([]),
    };
    const carrotConfig = {
      clearCache: vi.fn(),
      resetCycleCarrotGaps: vi.fn(),
      getCycleCarrotGaps: vi.fn().mockReturnValue({ missingFile: [], invalidFile: [] }),
      getConfig: opts.getConfig,
    };
    const state = {
      pruneStale: vi.fn(),
      load: vi.fn(),
      save: vi.fn(),
      getPrState: vi.fn().mockReturnValue(undefined),
      setPrState: vi.fn(),
    };
    const poller = new PollerService(
      provider as never,
      state as never,
      reviewer as never,
      carrotConfig as never,
      git as never,
      {} as never, // router — reviewer-triggered path never dispatches mentions
      'bot',
      1000,
      () => {},
    );
    return { poller, provider, reviewer, state };
  }

  it('auto-reviews a PR listing the bot as reviewer even when the repo has no chaxy config file', async () => {
    const pr = {
      id: 1,
      draft: false,
      authorUsername: 'human',
      sourceBranch: 'feature-1',
      sourceCommit: 'commit-1',
      targetBranch: 'main',
      reviewerUsernames: ['bot'],
    };
    const { poller, reviewer, state } = basePoller({ prs: [pr], getConfig: vi.fn().mockResolvedValue(null) });

    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();

    expect(reviewer.reviewPr).toHaveBeenCalledTimes(1);
    expect(reviewer.reviewPr.mock.calls[0]).toEqual(expect.arrayContaining(['P', 'r', 1, 'main', 'feature-1']));
    expect(state.setPrState).toHaveBeenCalledWith(
      'P/r',
      '1',
      expect.objectContaining({ lastReviewedCommit: 'commit-1' }),
    );
  });

  it('does not touch a repo with no config when no PR lists the bot as reviewer', async () => {
    const pr = {
      id: 2,
      draft: false,
      authorUsername: 'human',
      sourceBranch: 'feature-2',
      sourceCommit: 'commit-2',
      targetBranch: 'main',
      reviewerUsernames: ['someone-else'],
    };
    const { poller, reviewer, state } = basePoller({ prs: [pr], getConfig: vi.fn().mockResolvedValue(null) });

    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();

    expect(reviewer.reviewPr).not.toHaveBeenCalled();
    expect(state.setPrState).not.toHaveBeenCalled();
  });

  it('overrides only prReview=false for the reviewer-listed PR, not for other PRs in the same (configured) repo', async () => {
    const triggeredPr = {
      id: 3,
      draft: false,
      authorUsername: 'human',
      sourceBranch: 'feature-3',
      sourceCommit: 'commit-3',
      targetBranch: 'main',
      reviewerUsernames: ['bot'],
    };
    const ordinaryPr = {
      id: 4,
      draft: false,
      authorUsername: 'human',
      sourceBranch: 'feature-4',
      sourceCommit: 'commit-4',
      targetBranch: 'main',
      reviewerUsernames: [],
    };
    const { poller, reviewer } = basePoller({
      prs: [triggeredPr, ordinaryPr],
      getConfig: vi.fn().mockResolvedValue({ prReview: false, rulesFiles: [] }),
    });

    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();

    expect(reviewer.reviewPr).toHaveBeenCalledTimes(1);
    expect(reviewer.reviewPr.mock.calls[0]).toEqual(expect.arrayContaining([3]));
  });

  it('passes isFinalAutoReviewAttempt=true only once the retry cap is reached', async () => {
    const pr = {
      id: 5,
      draft: false,
      authorUsername: 'human',
      sourceBranch: 'feature-5',
      sourceCommit: 'commit-5',
      targetBranch: 'main',
      reviewerUsernames: ['bot'],
    };
    const reviewPr = vi.fn().mockRejectedValue(new Error('boom'));
    const { poller, state } = basePoller({ prs: [pr], getConfig: vi.fn().mockResolvedValue(null), reviewPr });

    // MAX_AUTO_REVIEW_ATTEMPTS is 3 — simulate 2 prior failures already recorded.
    (state.getPrState as any).mockReturnValue({ reviewFailures: 2, lastReviewedCommit: '' });

    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();

    // isFinalAutoReviewAttempt is the last positional arg.
    const args = reviewPr.mock.calls[0];
    expect(args[args.length - 1]).toBe(true);
  });
});
