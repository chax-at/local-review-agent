import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';

// Mock fs so pollCycle's temp-dir cleanup doesn't touch the real filesystem
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const exporter = new InMemorySpanExporter();
// The spans that have ended when the shutdown starts, i.e. the spans that the shutdown can export
let spansAtShutdown: string[] = [];
vi.mock('../../src/instrumentation/instrumentation', () => ({
  shutdownInstrumentation: vi.fn(async () => {
    spansAtShutdown = exporter.getFinishedSpans().map((span) => `${span.name}:${span.status.code}`);
  }),
}));

import { PollerService } from '../../src/poller/poller.service';
import { GitProviderAuthError } from '../../src/provider/provider';
import { shutdownInstrumentation } from '../../src/instrumentation/instrumentation';

const createPoller = (listProjects: () => Promise<unknown>): PollerService =>
  new PollerService(
    { listProjects } as never,
    { pruneStale: vi.fn(), save: vi.fn(), load: vi.fn() } as never,
    {} as never,
    {
      clearCache: vi.fn(),
      resetCycleCarrotGaps: vi.fn(),
      getCycleCarrotGaps: vi.fn().mockReturnValue({ missingFile: [], invalidFile: [] }),
    } as never,
    { resetFetchMemo: vi.fn() } as never,
    {} as never,
    'bot',
    1000,
    () => {},
  );

const runOneCycle = (poller: PollerService): Promise<void> =>
  (poller as unknown as { runOneCycle(): Promise<void> }).runOneCycle();

describe('poll cycle halt on an auth error', () => {
  beforeAll(() => {
    new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
  });

  afterEach(() => {
    exporter.reset();
    spansAtShutdown = [];
    vi.restoreAllMocks();
    vi.mocked(shutdownInstrumentation).mockClear();
  });

  afterAll(() => {
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('exports the telemetry after the failed poll cycle span has ended, then exits', async () => {
    // The real process.exit does not return
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(runOneCycle(createPoller(() => Promise.reject(new GitProviderAuthError('401'))))).rejects.toThrow(
      'process.exit',
    );

    expect(spansAtShutdown).toEqual([`poll cycle:${SpanStatusCode.ERROR}`]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does not exit for another error', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    await runOneCycle(createPoller(() => Promise.reject(new Error('timeout'))));

    expect(shutdownInstrumentation).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
