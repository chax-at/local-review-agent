import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { LlmClient, ILlmResponse } from './llm-client';
import type { IAuthoredFinding, IModelUsage } from '../types';
import { InfoActionsSchema, infoActionsJsonSchema, parseWithSchema } from './llm-schemas';

export interface ISearchHit {
  file: string;
  line: number;
  snippet: string;
}

/**
 * Repository access surface the gatherer uses to act on LLM-suggested
 * file loads and symbol searches. Kept abstract so the gatherer can be
 * unit-tested without touching the provider or running git.
 */
export interface IInfoTool {
  readFile(filePath: string): Promise<string | null>;
  searchSymbol(query: string): Promise<ISearchHit[]>;
}

/** Result of a single-file gather call. */
export interface ISingleFileGatheredInfo {
  /** Markdown blob to inject into this file's validator prompt. Empty if nothing was gathered. */
  context: string;
  usage: IModelUsage[];
  /** Number of LLM-proposed actions that produced usable context. */
  actionsApplied: number;
}

/** Aggregated result of gatherAll across every file. */
export interface IGatheredInfo {
  /**
   * Markdown blobs keyed by the finding file each one supports. Only files
   * for which the gatherer produced usable context appear in the map.
   */
  contextByFile: Map<string, string>;
  usage: IModelUsage[];
  actionsApplied: number;
}

/** Roughly 4 chars per token. Used to translate the token budget into a char cap. */
const CHARS_PER_TOKEN = 4;
/** Per-block char cap so one giant file can't eat the per-call budget. */
const MAX_BLOCK_CHARS = 16000;
/** Hard cap on actions a single gather call may request, to bound execution time. */
const MAX_ACTIONS = 10;
/** Max hits per search result (the rest are dropped). */
const MAX_SEARCH_HITS = 8;

export class InfoGatherer {
  constructor(
    private readonly llm: LlmClient | null,
    private readonly maxInfoTokens: number,
  ) {}

  public get isEnabled(): boolean {
    return this.llm !== null && this.maxInfoTokens > 0;
  }

  /**
   * Run one gather pass per finding-file. Each call is dedicated to a single
   * file's findings so the gatherer LLM stays focused; the resulting blobs
   * are aggregated into a per-file map that the validator injects into the
   * matching group prompt only.
   *
   * `requestsByFile`, when present, supplies per-file validator info requests
   * from a previous round. Files in `findingsByFile` that don't appear in
   * `requestsByFile` still get a proactive gather call (unless `onlyRequested`
   * is true, in which case the pass is restricted to files with requests —
   * used for the round-2 follow-up).
   */
  public async gatherAll(
    findingsByFile: Map<string, IAuthoredFinding[]>,
    diff: string,
    fileContentByPath: Map<string, string>,
    tools: IInfoTool,
    requestsByFile?: Map<string, string[]>,
    onlyRequested = false,
  ): Promise<IGatheredInfo> {
    if (!this.llm || this.maxInfoTokens <= 0 || findingsByFile.size === 0) {
      return { contextByFile: new Map(), usage: [], actionsApplied: 0 };
    }

    const contextByFile = new Map<string, string>();
    const usage: IModelUsage[] = [];
    let actionsApplied = 0;

    const targets = onlyRequested
      ? [...(requestsByFile?.keys() ?? [])].filter((p) => findingsByFile.has(p))
      : [...findingsByFile.keys()];

    // Per-file gather calls are independent — run them in parallel so wall
    // time scales with the slowest file, not the sum. `gather()` already
    // catches LLM/parse/tool errors internally and returns empty context, so
    // one slow or broken file can't poison the batch; allSettled adds a
    // belt-and-braces guard for unexpected throws.
    const settled = await Promise.allSettled(
      targets.map(async (filePath) => {
        const fileFindings = findingsByFile.get(filePath) ?? [];
        if (fileFindings.length === 0) return null;
        const requests = requestsByFile?.get(filePath);
        const result = await this.gather(filePath, fileFindings, diff, fileContentByPath, tools, requests);
        return { filePath, result };
      }),
    );

    for (const s of settled) {
      if (s.status !== 'fulfilled' || s.value === null) {
        if (s.status === 'rejected') {
          LogSink.warn(`Info gatherAll: per-file gather threw unexpectedly: ${s.reason}`, TraceTags.PI);
        }
        continue;
      }
      const { filePath, result } = s.value;
      usage.push(...result.usage);
      actionsApplied += result.actionsApplied;
      if (result.context) contextByFile.set(filePath, result.context);
    }

    return { contextByFile, usage, actionsApplied };
  }

  /**
   * One gather call scoped to a single file's findings. Asks the LLM what
   * extra files/symbols would help validators judge THESE findings, fetches
   * them under the per-call token budget, and returns a markdown blob.
   *
   * When `requests` is non-empty (round-2 follow-up), those validator
   * requests are the primary signal for the LLM.
   */
  public async gather(
    filePath: string,
    findings: IAuthoredFinding[],
    diff: string,
    fileContentByPath: Map<string, string>,
    tools: IInfoTool,
    requests?: string[],
  ): Promise<ISingleFileGatheredInfo> {
    if (!this.llm || this.maxInfoTokens <= 0 || findings.length === 0) {
      return { context: '', usage: [], actionsApplied: 0 };
    }

    const hasRequests = !!requests && requests.length > 0;

    const systemPrompt = [
      `You are gathering additional context to help code-review validators judge findings on \`${filePath}\`.`,
      hasRequests
        ? 'Validators have already done a first vote and have asked for SPECIFIC extra context (listed below). Treat those requests as the primary signal and translate them into concrete actions.'
        : 'Given the findings on this file and the already-loaded context, propose up to 10 actions to fetch information that would let a validator confirm whether each finding is a real defect.',
      '',
      'Action types (return JSON: { "actions": [{ "type": ..., "target": ... }, ...] }):',
      '- { "type": "file",   "target": "<repo-relative path>" } — load an additional whole file',
      '- { "type": "search", "target": "<symbol or string>" } — search the repo for a symbol/string',
      '',
      'Prioritize:',
      `- Type / interface / DTO definitions referenced by code in \`${filePath}\``,
      '- Functions or classes called from the changed code',
      '- API contracts the changed code consumes',
      '',
      'Skip:',
      '- Files already loaded (listed below)',
      '- Lockfiles, node_modules, dist, build outputs, generated code',
      '- Findings that are self-contained (style nits, unused imports, etc.)',
      '',
      'If no extra context is needed, return { "actions": [] }.',
    ].join('\n');

    const loadedFiles = [...fileContentByPath.keys()];
    const sections = [
      `## File under review: \`${filePath}\``,
      `## Already loaded files (do not re-request):\n${loadedFiles.length > 0 ? loadedFiles.map((p) => `- ${p}`).join('\n') : '(none)'}`,
      `## Diff (full PR — focus on changes touching \`${filePath}\`):\n\`\`\`\n${diff.slice(0, 8000)}\n\`\`\``,
      `## Findings on \`${filePath}\`:\n${JSON.stringify(
        findings.map((f) => ({ line: f.line, severity: f.severity, comment: f.comment.slice(0, 400) })),
      )}`,
    ];
    if (requests && requests.length > 0) {
      sections.unshift(
        `## Validator info requests for \`${filePath}\` (translate each into one or more actions):\n${requests
          .slice(0, 15)
          .map((r) => `- ${r.slice(0, 300)}`)
          .join('\n')}`,
      );
    }
    const userMessage = sections.join('\n\n');

    let response: ILlmResponse;
    try {
      response = await this.llm.chat(systemPrompt, userMessage, {
        jsonMode: true,
        jsonSchema: infoActionsJsonSchema,
      });
    } catch (err) {
      LogSink.warn(`Info gatherer ${this.llm.name} failed for ${filePath}: ${err}`, TraceTags.PI);
      return { context: '', usage: [], actionsApplied: 0 };
    }

    const usage = [this.trackUsage(response)];
    const parsed = parseWithSchema(response.content, InfoActionsSchema);
    if (!parsed) {
      LogSink.warn(`Info gatherer ${this.llm.name} returned unparseable response for ${filePath}`, TraceTags.PI);
      return { context: '', usage, actionsApplied: 0 };
    }

    const blocks: string[] = [];
    const charBudget = this.maxInfoTokens * CHARS_PER_TOKEN;
    let used = 0;
    let actionsApplied = 0;
    const seenFiles = new Set(fileContentByPath.keys());
    const seenQueries = new Set<string>();

    for (const action of parsed.actions.slice(0, MAX_ACTIONS)) {
      if (used >= charBudget) break;
      const remaining = charBudget - used;
      const perBlockCap = Math.min(remaining, MAX_BLOCK_CHARS);
      const block = await this.executeAction(action, tools, seenFiles, seenQueries, perBlockCap);
      if (!block) continue;
      blocks.push(block);
      used += block.length;
      actionsApplied++;
    }

    if (blocks.length === 0) {
      return { context: '', usage, actionsApplied: 0 };
    }

    return {
      context: `# Additional context for \`${filePath}\` (gathered):\n\n${blocks.join('\n\n')}\n`,
      usage,
      actionsApplied,
    };
  }

  private async executeAction(
    action: { type: 'file' | 'search'; target: string },
    tools: IInfoTool,
    seenFiles: Set<string>,
    seenQueries: Set<string>,
    cap: number,
  ): Promise<string | null> {
    const target = action.target.trim();
    if (!target) return null;

    if (action.type === 'file') {
      if (seenFiles.has(target)) return null;
      seenFiles.add(target);
      let content: string | null;
      try {
        content = await tools.readFile(target);
      } catch (err) {
        LogSink.debug(`Info gatherer: readFile(${target}) threw: ${err}`, TraceTags.PI);
        return null;
      }
      if (!content) return null;
      return `## File \`${target}\`:\n\`\`\`\n${content.slice(0, cap)}\n\`\`\``;
    }

    // action.type === 'search'
    if (seenQueries.has(target)) return null;
    seenQueries.add(target);
    let hits: ISearchHit[];
    try {
      hits = await tools.searchSymbol(target);
    } catch (err) {
      LogSink.debug(`Info gatherer: searchSymbol(${target}) threw: ${err}`, TraceTags.PI);
      return null;
    }
    if (hits.length === 0) return null;
    const lines = hits.slice(0, MAX_SEARCH_HITS).map((h) => `${h.file}:${h.line}: ${h.snippet.slice(0, 240)}`);
    const body = lines.join('\n').slice(0, cap);
    return `## Search \`${target}\`:\n\`\`\`\n${body}\n\`\`\``;
  }

  private trackUsage(response: ILlmResponse): IModelUsage {
    const llm = this.llm!;
    const cost =
      (response.inputTokens / 1_000_000) * llm.inputCostPer1M +
      (response.outputTokens / 1_000_000) * llm.outputCostPer1M;
    return {
      modelName: llm.name,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costEur: cost,
    };
  }
}
