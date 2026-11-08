import { metrics } from '@opentelemetry/api';
import type { IModelUsage } from '../types';
import { INSTRUMENTATION_SCOPE } from './tracing';

const meter = metrics.getMeter(INSTRUMENTATION_SCOPE);

export type ReviewOutcome = 'reviewed' | 'skipped' | 'failed';

export const metricMeters = {
  errors: meter.createCounter<{
    type: string;
    // The app has no HTTP server, therefore every error comes from background work (poll cycle, review, ticket)
    transport: 'background';
    log_level: string;
  }>('local_git_reviewer.error.count', {
    description: 'Number of errors that have been logged',
  }),
  reviews: meter.createCounter<{ outcome: ReviewOutcome }>('local_git_reviewer.review.count', {
    description: 'Number of PR review runs',
  }),
  reviewDuration: meter.createHistogram<{ outcome: ReviewOutcome }>('local_git_reviewer.review.duration', {
    description: 'Duration of a PR review run',
    unit: 's',
  }),
  llmTokens: meter.createCounter<{ model: string; token_type: 'input' | 'output' }>(
    'local_git_reviewer.llm.token.count',
    { description: 'Number of LLM tokens that the bot comments report' },
  ),
  llmCost: meter.createCounter<{ model: string }>('local_git_reviewer.llm.cost', {
    description: 'Estimated LLM cost that the bot comments report',
    unit: 'EUR',
  }),
};

/** The model name is the name in the comment footer, e.g. `Opus (readability)`. The configured models limit it. */
export function recordModelUsage(usage: IModelUsage[]): void {
  for (const u of usage) {
    metricMeters.llmTokens.add(u.inputTokens, { model: u.modelName, token_type: 'input' });
    metricMeters.llmTokens.add(u.outputTokens, { model: u.modelName, token_type: 'output' });
    metricMeters.llmCost.add(u.costEur, { model: u.modelName });
  }
}
