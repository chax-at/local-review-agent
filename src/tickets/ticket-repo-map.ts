import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { ICarrotConfig } from '../config/carrot-config.types';
import { chatWithFallback, type LlmClient } from '../reviewer/llm-client';
import { RepoPickSchema, repoPickJsonSchema, parseWithSchema } from '../reviewer/llm-schemas';
import type { IModelUsage } from '../types';

export interface ITicketRepo {
  project: string;
  slug: string;
  config: ICarrotConfig;
}

/** Uppercase Jira project key → repos whose .carrot.jsonc claims it. */
export type TicketRepoMap = Map<string, ITicketRepo[]>;

/** 'ABC-123' → 'ABC'. */
export function projectKeyOf(ticketKey: string): string {
  const dash = ticketKey.indexOf('-');
  return (dash > 0 ? ticketKey.slice(0, dash) : ticketKey).toUpperCase();
}

export function buildRepoMap(
  repos: Array<{ project: string; slug: string; config: ICarrotConfig | null }>,
): TicketRepoMap {
  const map: TicketRepoMap = new Map();
  for (const repo of repos) {
    if (!repo.config?.jiraProjects) continue;
    for (const rawKey of repo.config.jiraProjects) {
      const key = rawKey.trim().toUpperCase();
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push({ project: repo.project, slug: repo.slug, config: repo.config });
      map.set(key, list);
    }
  }
  return map;
}

const SYSTEM_PROMPT = [
  'You decide which repository a Jira ticket belongs to.',
  'You get the ticket summary and description and a list of candidate repository slugs.',
  'Answer with JSON: { "slug": "<one of the candidates>", "confidence": "high" | "low", "reasoning": "one sentence" }.',
  'Use "high" only when the ticket text clearly names or implies exactly one repository. Otherwise use "low".',
].join('\n');

/**
 * Picks one repo when a Jira project key is claimed by several. One
 * structured LLM call on the aux model. Anything but a confident, valid pick
 * returns null so the caller can ask the human instead of guessing.
 */
export class RepoPicker {
  constructor(
    private readonly llm: LlmClient | null,
    private readonly fallbackLlm: LlmClient | null = null,
  ) {}

  public async pick(
    ticket: { key: string; summary: string; description: string },
    candidates: ITicketRepo[],
  ): Promise<{ repo: ITicketRepo | null; usage: IModelUsage[] }> {
    if (candidates.length === 1) return { repo: candidates[0], usage: [] };
    if (candidates.length === 0 || !this.llm) return { repo: null, usage: [] };

    const userMessage = [
      `Ticket ${ticket.key}: ${ticket.summary}`,
      '',
      ticket.description.slice(0, 4000),
      '',
      `Candidates: ${candidates.map((c) => c.slug).join(', ')}`,
    ].join('\n');

    try {
      const { response, servedBy } = await chatWithFallback(this.llm, this.fallbackLlm, SYSTEM_PROMPT, userMessage, {
        jsonMode: true,
        jsonSchema: repoPickJsonSchema,
      });
      const usage: IModelUsage[] = [
        {
          modelName: `${servedBy.name} (repo picker)`,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costEur:
            (response.inputTokens / 1_000_000) * servedBy.inputCostPer1M +
            (response.outputTokens / 1_000_000) * servedBy.outputCostPer1M,
        },
      ];
      const parsed = parseWithSchema(response.content, RepoPickSchema);
      if (!parsed || parsed.confidence !== 'high') {
        LogSink.info(
          `Repo picker: no confident pick for ${ticket.key} (${parsed?.reasoning ?? 'unparseable'})`,
          TraceTags.JIRA,
        );
        return { repo: null, usage };
      }
      const repo = candidates.find((c) => c.slug === parsed.slug) ?? null;
      if (!repo) {
        LogSink.warn(
          `Repo picker: ${servedBy.name} answered unknown slug "${parsed.slug}" for ${ticket.key}`,
          TraceTags.JIRA,
        );
      }
      return { repo, usage };
    } catch (err) {
      LogSink.warn(`Repo picker failed for ${ticket.key}: ${err}`, TraceTags.JIRA);
      return { repo: null, usage: [] };
    }
  }
}
