import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { PollerService } from '../../src/poller/poller.service';
import type { IActivity, IComment } from '../../src/provider/provider.types';
import { toCommentCloud } from '../../src/provider/bitbucket-cloud/cloud.mappers';
import type { ICloudComment } from '../../src/provider/bitbucket-cloud/cloud.types';
import { toActivity } from '../../src/provider/bitbucket-server/server.mappers';
import type { IBitbucketActivity } from '../../src/provider/bitbucket-server/server.types';

const pr = {
  id: 42,
  draft: false,
  authorUsername: 'human',
  sourceBranch: 'feature-42',
  sourceCommit: 'commit-42',
  targetBranch: 'main',
};

/**
 * One configured repo with one PR, auto-review off, so only mention dispatch runs.
 * `getComment` answers like the provider would for a reply that the bot has not answered yet.
 */
const harness = (activities: IActivity[]) => {
  const provider = {
    listProjects: vi.fn().mockResolvedValue([{ key: 'P' }]),
    listRepos: vi.fn().mockResolvedValue([{ slug: 'r' }]),
    getOpenPullRequests: vi.fn().mockResolvedValue([pr]),
    getLatestCommitTimestampMs: vi.fn().mockResolvedValue(Date.now()),
    getActivities: vi.fn().mockResolvedValue(activities),
    getComment: vi.fn(
      async (_p: string, _s: string, _prId: number, commentId: number): Promise<IComment> => ({
        id: commentId,
        text: '',
        authorUsername: 'human',
        replies: [],
      }),
    ),
    getComments: vi.fn().mockResolvedValue([]),
    replyToComment: vi.fn().mockResolvedValue(undefined),
    postGeneralComment: vi.fn().mockResolvedValue(undefined),
  };
  const carrotConfig = {
    clearCache: vi.fn(),
    resetCycleCarrotGaps: vi.fn(),
    getCycleCarrotGaps: vi.fn().mockReturnValue({ missingFile: [], invalidFile: [] }),
    getConfig: vi.fn().mockResolvedValue({ prReview: false, rulesFiles: [], generateFixPrompts: false }),
  };
  const state = {
    pruneStale: vi.fn(),
    load: vi.fn(),
    save: vi.fn(),
    getPrState: vi.fn().mockReturnValue(undefined),
    setPrState: vi.fn(),
  };
  const router = {
    route: vi.fn().mockResolvedValue({ tool: 'ignore', message: '', reasoning: 'test' }),
    firstAvailableLlm: undefined,
  };
  const poller = new PollerService(
    provider as never,
    state as never,
    { reviewPr: vi.fn() } as never,
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
  return { provider, router, state, runCycle, onItCommentIds };
};

const cloudWire = (id: number, raw: string, extra: Partial<ICloudComment> = {}): ICloudComment => ({
  id,
  content: { raw },
  user: { account_id: 'human' } as ICloudComment['user'],
  created_on: '2026-10-01T00:00:00Z',
  ...extra,
});

/** Same shape as BitbucketCloudClient.getActivities: one activity per comment, replies included. */
const cloudActivities = (wires: ICloudComment[]): IActivity[] =>
  wires.map((w) => ({ id: w.id, comment: toCommentCloud(w, wires) }));

describe('checkMentions dispatches each comment id once per cycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Cloud shape: a reply mention that is also its own activity is dispatched once, with the thread context', async () => {
    const wires = [
      cloudWire(10, 'this loop looks off', { inline: { path: 'src/a.ts', to: 7 } }),
      cloudWire(11, '@bot explain this', { parent: { id: 10 }, inline: { path: 'src/a.ts', to: 7 } }),
      cloudWire(12, 'I agree with the loop concern', { parent: { id: 10 }, inline: { path: 'src/a.ts', to: 7 } }),
    ];
    const { router, runCycle, onItCommentIds, state } = harness(cloudActivities(wires));

    await runCycle();

    expect(onItCommentIds()).toEqual([11]);
    expect(router.route).toHaveBeenCalledTimes(1);
    // The nested-reply occurrence carries the sibling reply of the thread.
    expect(router.route.mock.calls[0][0]).toContain('I agree with the loop concern');
    expect(router.route.mock.calls[0][0]).toContain('src/a.ts:7');
    expect(state.setPrState).toHaveBeenCalledWith('P/r', '42', expect.objectContaining({ processedMentionIds: [11] }));
  });

  it('Server shape: a REPLIED activity listed before the root COMMENTED activity is dispatched once, with the thread context', async () => {
    // Bitbucket Server lists activities newest first. Assumed shape (not verified on a live
    // server): the reply's own activity (commentAction REPLIED) carries the reply comment,
    // and the root's activity nests it. toActivity ignores `action`.
    const wires: IBitbucketActivity[] = [
      {
        id: 302,
        action: 'COMMENTED',
        comment: { id: 21, text: '@bot explain this', author: { slug: 'human' }, comments: [] },
      },
      {
        id: 301,
        action: 'COMMENTED',
        comment: {
          id: 20,
          text: 'this loop looks off',
          author: { slug: 'human' },
          anchor: { path: 'src/a.ts', line: 7, lineType: 'ADDED' },
          comments: [
            { id: 21, text: '@bot explain this', author: { slug: 'human' } },
            { id: 22, text: 'I agree with the loop concern', author: { slug: 'human' } },
          ],
        },
      },
    ];
    const { router, runCycle, onItCommentIds } = harness(wires.map(toActivity));

    await runCycle();

    expect(onItCommentIds()).toEqual([21]);
    expect(router.route).toHaveBeenCalledTimes(1);
    expect(router.route.mock.calls[0][0]).toContain('I agree with the loop concern');
    expect(router.route.mock.calls[0][0]).toContain('src/a.ts:7');
  });

  it('a single top-level mention is still dispatched once', async () => {
    const { router, runCycle, onItCommentIds } = harness(cloudActivities([cloudWire(30, '@bot review this')]));

    await runCycle();

    expect(onItCommentIds()).toEqual([30]);
    expect(router.route).toHaveBeenCalledTimes(1);
  });

  it('two different mentions are still dispatched twice', async () => {
    const wires = [
      cloudWire(40, '@bot review this'),
      cloudWire(41, 'thread root', { inline: { path: 'src/b.ts', to: 3 } }),
      cloudWire(42, '@bot explain this', { parent: { id: 41 }, inline: { path: 'src/b.ts', to: 3 } }),
    ];
    const { router, runCycle, onItCommentIds } = harness(cloudActivities(wires));

    await runCycle();

    expect(onItCommentIds()).toEqual([40, 42]);
    expect(router.route).toHaveBeenCalledTimes(2);
  });
});
