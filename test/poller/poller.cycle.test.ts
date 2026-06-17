import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs so pollCycle's heartbeat write and temp-dir cleanup don't touch
// the real filesystem (cleanupTempDir would wipe the live /tmp/carrot dir).
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { PollerService } from '../../src/poller/poller.service';
import { BambooPollerService } from '../../src/bamboo/bamboo.poller.service';

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
      {} as never, // audit — unused with no projects
      git as never,
      {} as never, // router — unused with no projects
      'bot',
      1000,
      '/tmp/heartbeat',
    );
    await (poller as unknown as { pollCycle(): Promise<void> }).pollCycle();
    expect(git.resetFetchMemo).toHaveBeenCalled();
    expect(git.resetFetchMemo.mock.invocationCallOrder[0]).toBeLessThan(
      provider.listProjects.mock.invocationCallOrder[0],
    );
  });

  it('BambooPollerService.pollCycle clears the git fetch memo before polling', async () => {
    const bamboo = new BambooPollerService({
      state: state as never,
      audit: {} as never, // unused with no projects
      provider: provider as never,
      carrotConfig: carrotConfig as never,
      git: git as never,
      intervalMs: 1000,
    });
    await bamboo.pollCycle();
    expect(git.resetFetchMemo).toHaveBeenCalled();
    expect(git.resetFetchMemo.mock.invocationCallOrder[0]).toBeLessThan(
      provider.listProjects.mock.invocationCallOrder[0],
    );
  });
});
