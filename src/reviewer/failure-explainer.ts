import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import { chatWithFallback, type LlmClient } from './llm-client';
import type { IModelUsage } from '../types';

const MAX_RAW_ERROR_CHARS = 4000;
/** Cap on the plain-error fallback shown when no LLM explanation is available. */
const MAX_FALLBACK_CHARS = 500;

const SYSTEM_PROMPT = [
  'You explain automated code-review failures to a developer reading a PR comment.',
  'You get a raw error (possibly a stack trace) from the review pipeline: Docker, git, an LLM call, or similar.',
  'Write 1-3 short, plain-language sentences: what likely went wrong and, if obvious, what to check',
  '(e.g. Docker not running, a model endpoint unreachable, a bad config value, a network timeout).',
  "If the cause isn't clear from the error, say that plainly instead of guessing.",
  'Do not include the raw error/stack trace verbatim — summarize it.',
].join('\n');

/**
 * Turns a raw pipeline error into a short, PR-readable explanation using one
 * of the auxiliary LLMs (same primary/fallback pair as info-gather/context-
 * explore/dedup — see `REVIEW_AUX_MODEL_SLOT`/`REVIEW_AUX_FALLBACK_MODEL_SLOT`).
 * Never throws: any failure (including "no LLM configured") degrades to the
 * raw error text, truncated, so the PR always gets SOME explanation.
 */
export class FailureExplainer {
  constructor(
    private readonly llm: LlmClient | null,
    private readonly fallbackLlm: LlmClient | null = null,
  ) {}

  public get isEnabled(): boolean {
    return this.llm !== null;
  }

  public async explain(rawError: string): Promise<{ text: string; usage: IModelUsage[] }> {
    if (!this.llm) {
      return { text: rawError.slice(0, MAX_FALLBACK_CHARS), usage: [] };
    }

    try {
      const { response, servedBy } = await chatWithFallback(
        this.llm,
        this.fallbackLlm,
        SYSTEM_PROMPT,
        rawError.slice(0, MAX_RAW_ERROR_CHARS),
      );
      const text = response.content.trim();
      const cost =
        (response.inputTokens / 1_000_000) * servedBy.inputCostPer1M +
        (response.outputTokens / 1_000_000) * servedBy.outputCostPer1M;
      const usage: IModelUsage[] = [
        {
          modelName: `${servedBy.name} (failure explainer)`,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costEur: cost,
        },
      ];
      return { text: text || rawError.slice(0, MAX_FALLBACK_CHARS), usage };
    } catch (err) {
      LogSink.warn(`Failure explainer failed, falling back to raw error text: ${err}`, TraceTags.PI);
      return { text: rawError.slice(0, MAX_FALLBACK_CHARS), usage: [] };
    }
  }
}
