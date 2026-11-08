import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReviewerService } from '../../src/reviewer/reviewer.service';
import { MultiModelValidator } from '../../src/reviewer/multi-model-validator';
import { InfoGatherer } from '../../src/reviewer/info-gatherer';
import { ContextExplorer } from '../../src/reviewer/context-explorer';
import { SecurityScanner } from '../../src/reviewer/security-scanner';
import { FindingDeduplicator } from '../../src/reviewer/finding-deduplicator';
import { FailureExplainer } from '../../src/reviewer/failure-explainer';
import { JiraService } from '../../src/jira/jira.service';
import { CarrotConfigService } from '../../src/config/carrot-config.service';
import { metricMeters } from '../../src/instrumentation/metrics';
import { reviewCommitMarker } from '../../src/reviewer/review-marker';

/**
 * Builds a ReviewerService whose review pass fails immediately (git.cloneOrFetch
 * throws), so every test here exercises only reviewPr's catch/failure-comment
 * path, not the rest of the review pipeline.
 */
function buildFailingReviewerService(opts: { failureExplainer?: FailureExplainer } = {}) {
  const provider = {
    getComments: vi.fn().mockResolvedValue([]),
    getPullRequest: vi.fn().mockResolvedValue(null),
    updateComment: vi.fn().mockResolvedValue(undefined),
    postGeneralComment: vi.fn().mockResolvedValue(undefined),
  };
  const git = {
    redactPat: (s: string) => s,
    cloneOrFetch: vi.fn(() => {
      throw new Error('docker: Cannot connect to the Docker daemon');
    }),
  };
  const jira = new JiraService('', '', '', []);
  const carrotConfigService = new CarrotConfigService(provider as never);

  const service = new ReviewerService(
    provider as never,
    git as never,
    [], // reviewModels — unused, cloneOrFetch throws before this matters
    'bot',
    5000,
    1000,
    new MultiModelValidator([]),
    carrotConfigService,
    new InfoGatherer(null, 0),
    new FindingDeduplicator(null),
    0,
    new ContextExplorer(null, 0),
    new SecurityScanner(false),
    jira,
    () => {},
    opts.failureExplainer ?? new FailureExplainer(null),
  );

  return { service, provider };
}

describe('ReviewerService.reviewPr failure comment', () => {
  it('posts only the raw error on a non-final attempt, even with an explainer configured', async () => {
    const llm = {
      name: 'Fable',
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      chat: vi.fn().mockResolvedValue({ content: 'Docker is not running on the review host.', inputTokens: 1, outputTokens: 1 }),
    } as any;
    const { service, provider } = buildFailingReviewerService({ failureExplainer: new FailureExplainer(llm) });

    await expect(service.reviewPr('P', 'r', 1, 'main', 'feat', undefined, undefined, undefined, 'c1', true, false)).rejects.toThrow();

    expect(llm.chat).not.toHaveBeenCalled();
    const [, , , text] = provider.postGeneralComment.mock.calls[0];
    expect(text).toContain('Automated review failed:');
    expect(text).toContain('docker');
    expect(text).not.toContain('will not retry automatically');
  });

  it('posts an LLM-written explanation plus a give-up note on the final attempt', async () => {
    const llm = {
      name: 'Fable',
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      chat: vi.fn().mockResolvedValue({
        content: 'Docker is not reachable on the review host, so the pipeline could not run.',
        inputTokens: 1,
        outputTokens: 1,
      }),
    } as any;
    const { service, provider } = buildFailingReviewerService({ failureExplainer: new FailureExplainer(llm) });

    await expect(service.reviewPr('P', 'r', 1, 'main', 'feat', undefined, undefined, undefined, 'c1', true, true)).rejects.toThrow();

    expect(llm.chat).toHaveBeenCalledTimes(1);
    const [, , , text] = provider.postGeneralComment.mock.calls[0];
    expect(text).toContain('will not retry automatically');
    expect(text).toContain('Docker is not reachable on the review host');
    expect(text).toContain('Raw error:');
    expect(text).toContain('Mention @bot');
  });

  it('degrades to the raw error on the final attempt when no explainer model is configured', async () => {
    const { service, provider } = buildFailingReviewerService(); // default FailureExplainer(null)

    await expect(service.reviewPr('P', 'r', 1, 'main', 'feat', undefined, undefined, undefined, 'c1', true, true)).rejects.toThrow();

    const [, , , text] = provider.postGeneralComment.mock.calls[0];
    expect(text).toContain('Automated review failed:');
    expect(text).not.toContain('will not retry automatically');
  });

  it('updates the existing failure comment in place instead of posting a new one', async () => {
    const { service, provider } = buildFailingReviewerService();
    provider.getComments.mockResolvedValue([
      { id: 55, authorUsername: 'bot', text: 'Automated review failed: an earlier error', replies: [] },
    ]);

    await expect(service.reviewPr('P', 'r', 1, 'main', 'feat')).rejects.toThrow();

    expect(provider.postGeneralComment).not.toHaveBeenCalled();
    expect(provider.updateComment).toHaveBeenCalledWith('P', 'r', 1, 55, expect.stringContaining('Automated review failed:'));
  });
});

describe('ReviewerService.reviewPr metrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts a failed review run with its duration', async () => {
    const addReview = vi.spyOn(metricMeters.reviews, 'add');
    const recordDuration = vi.spyOn(metricMeters.reviewDuration, 'record');
    const { service } = buildFailingReviewerService();

    await expect(service.reviewPr('P', 'r', 1, 'main', 'feat')).rejects.toThrow('Cannot connect to the Docker daemon');

    expect(addReview).toHaveBeenCalledWith(1, { outcome: 'failed' });
    expect(recordDuration).toHaveBeenCalledWith(expect.any(Number), { outcome: 'failed' });
  });

  it('counts a review run that finds the review of the commit on the PR as skipped', async () => {
    const addReview = vi.spyOn(metricMeters.reviews, 'add');
    const { service, provider } = buildFailingReviewerService();
    provider.getComments.mockResolvedValue([
      { id: 56, authorUsername: 'bot', text: `Review summary ${reviewCommitMarker('c1')}`, replies: [] },
    ]);

    await service.reviewPr('P', 'r', 1, 'main', 'feat', undefined, undefined, undefined, 'c1', true);

    expect(addReview).toHaveBeenCalledWith(1, { outcome: 'skipped' });
  });
});
