import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { LlmClient, ILlmResponse } from './llm-client';
import type { IModelUsage } from '../types';
import { InfoActionsSchema, infoActionsJsonSchema, parseWithSchema } from './llm-schemas';
import { CHARS_PER_TOKEN, MAX_BLOCK_CHARS, executeInfoAction, type IInfoTool } from './info-gatherer';

export interface IExplorationResult {
  /** Markdown blob to attach as context.md to every reviewer run. Empty if nothing was gathered. */
  context: string;
  usage: IModelUsage[];
}

/** Upper bound on propose→execute rounds per PR, to bound cost and wall time. */
const MAX_ROUNDS = 3;
/** Hard cap on actions a single round may request. */
const MAX_ACTIONS_PER_ROUND = 8;
/** Diff excerpt shown to the explorer each round. */
const MAX_DIFF_CHARS = 16000;

const SYSTEM_PROMPT = [
  'You are exploring a repository to gather context that helps code reviewers judge a PR diff.',
  'The reviewers see ONLY the diff plus what you gather here — they cannot open files themselves.',
  '',
  `Propose up to ${MAX_ACTIONS_PER_ROUND} actions (return JSON: { "actions": [{ "type": ..., "target": ... }, ...] }):`,
  '- { "type": "file",   "target": "<repo-relative path>" } — load a whole file',
  '- { "type": "search", "target": "<symbol or string>" } — search the repo for a symbol/string',
  '',
  'Prioritize:',
  '- Callers of functions/methods whose behavior or signature the diff changes',
  '- Type / interface / DTO definitions referenced by the changed code',
  '- API contracts or invariants the changed code consumes or must uphold',
  '',
  'Skip lockfiles, node_modules, dist/build outputs, and generated code.',
  'You will receive the results and may propose follow-up actions in the next round.',
  'When you have gathered enough (or nothing more would help), return { "actions": [] }.',
].join('\n');

/**
 * Pre-review exploration pass: a small agentic loop that walks the repository
 * starting from the diff and produces one markdown context blob (callers, type
 * definitions, related code). The blob is attached to every reviewer run so the
 * tool-less reviewers gain cross-file context while exploration cost is paid
 * once per PR — not once per (model × role) run.
 *
 * Mirrors InfoGatherer's action contract but runs BEFORE the review (no
 * findings exist yet) and loops: each round's results are fed back so the LLM
 * can follow leads (read a file, then search for a symbol it saw there).
 *
 * Never throws — a broken exploration must degrade to a diff-only review, not
 * block it.
 */
export class ContextExplorer {
  constructor(
    private readonly llm: LlmClient | null,
    private readonly maxExplorationTokens: number,
  ) {}

  public get isEnabled(): boolean {
    return this.llm !== null && this.maxExplorationTokens > 0;
  }

  public async explore(diff: string, tools: IInfoTool, intent?: string | null): Promise<IExplorationResult> {
    if (!this.llm || this.maxExplorationTokens <= 0) {
      return { context: '', usage: [] };
    }

    const blocks: string[] = [];
    const usage: IModelUsage[] = [];
    const charBudget = this.maxExplorationTokens * CHARS_PER_TOKEN;
    let used = 0;
    const seenFiles = new Set<string>();
    const seenQueries = new Set<string>();

    for (let round = 0; round < MAX_ROUNDS && used < charBudget; round++) {
      let response: ILlmResponse;
      try {
        response = await this.llm.chat(SYSTEM_PROMPT, this.buildUserMessage(diff, blocks, intent), {
          jsonMode: true,
          jsonSchema: infoActionsJsonSchema,
        });
      } catch (err) {
        LogSink.warn(`Context explorer ${this.llm.name} failed in round ${round + 1}: ${err}`, TraceTags.PI);
        break;
      }
      usage.push(this.trackUsage(response));

      const parsed = parseWithSchema(response.content, InfoActionsSchema);
      if (!parsed) {
        LogSink.warn(
          `Context explorer ${this.llm.name} returned unparseable response in round ${round + 1}`,
          TraceTags.PI,
        );
        break;
      }
      if (parsed.actions.length === 0) break;

      let newBlocks = 0;
      for (const action of parsed.actions.slice(0, MAX_ACTIONS_PER_ROUND)) {
        if (used >= charBudget) break;
        const perBlockCap = Math.min(charBudget - used, MAX_BLOCK_CHARS);
        const block = await executeInfoAction(action, tools, seenFiles, seenQueries, perBlockCap);
        if (!block) continue;
        blocks.push(block);
        used += block.length;
        newBlocks++;
      }
      // A round that produced nothing new means the model is re-treading
      // ground (or every target failed) — further rounds won't converge.
      if (newBlocks === 0) break;
    }

    if (blocks.length === 0) {
      return { context: '', usage };
    }
    return {
      context: `# Repository context (gathered for this diff):\n\n${blocks.join('\n\n')}\n`,
      usage,
    };
  }

  private buildUserMessage(diff: string, blocks: string[], intent?: string | null): string {
    const sections: string[] = [];
    if (intent && intent.trim()) {
      sections.push(`## PR intent (title/description/ticket — steer exploration by it):\n${intent.trim()}`);
    }
    sections.push(
      `## PR diff (may be truncated):\n\`\`\`\n${diff.slice(0, MAX_DIFF_CHARS)}\n\`\`\``,
      `## Context gathered so far:\n${blocks.length > 0 ? blocks.join('\n\n') : '(none yet)'}`,
    );
    return sections.join('\n\n');
  }

  private trackUsage(response: ILlmResponse): IModelUsage {
    const llm = this.llm!;
    const cost =
      (response.inputTokens / 1_000_000) * llm.inputCostPer1M +
      (response.outputTokens / 1_000_000) * llm.outputCostPer1M;
    return {
      modelName: `${llm.name} (exploration)`,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costEur: cost,
    };
  }
}
