import { LlmClient } from './llm-client';
import type { IReviewFinding, IModelUsage, IAuthoredFinding } from '../types';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import { extractAddedLines } from './diff.utils';
import {
  FindingsValidationSchema,
  FindingsValidationWithInfoSchema,
  FixValidationSchema,
  TextFixProposalsSchema,
  findingsValidationJsonSchema,
  findingsValidationWithInfoJsonSchema,
  fixValidationJsonSchema,
  textFixProposalsJsonSchema,
  parseWithSchema,
} from './llm-schemas';

/**
 * A proposed inline ` ```suggestion ` edit for one finding: either a `replace`
 * spanning a contiguous range of ADDED (new-file) lines, or a `skip`. Produced
 * by {@link MultiModelValidator.proposeTextFixes} and gated by
 * {@link MultiModelValidator.validateSuggestions} before posting.
 */
export type IFixProposal =
  | { action: 'replace'; findingIndex: number; replacement: string; startLine: number; endLine: number }
  | { action: 'skip'; findingIndex: number; reason: string };

export interface IValidatedFinding extends IReviewFinding {
  validationNotes: string;
}

export interface IValidationResult {
  findings: IValidatedFinding[];
  usage: IModelUsage[];
  discardedRound1: number;
  discardedRound2: number;
}

export interface IFixValidationResult {
  approved: boolean;
  summary: string;
  usage: IModelUsage[];
}

export interface ISuggestionValidationResult {
  /** Approved fix proposals, keyed by findingIndex. */
  approvedSuggestions: Map<number, IFixProposal>;
  usage: IModelUsage[];
  discardedRound1: number;
  discardedRound2: number;
}

interface IVoteEntry {
  model: string;
  phase: 'round1' | 'round2';
  /** null = no response / abstain */
  relevant: boolean | null;
  /** Empty string when no response */
  thought: string;
  /** Round-1 only: validator's request for additional context. Empty string = no request. */
  infoRequest?: string;
}

/**
 * Callback the validator uses to ask for a follow-up info-gathering pass
 * between rounds. The requests are grouped by the finding file each came from
 * so the gatherer can produce per-file context — matching the proactive pass.
 */
export type IFollowUpInfoGatherer = (
  requestsByFile: Map<string, string[]>,
) => Promise<{ contextByFile: Map<string, string>; usage: IModelUsage[] }>;

interface IFindingVote {
  entries: IVoteEntry[];
  votes: number;
  totalResponses: number;
}

/**
 * Render entries as plain strings (used to feed peers' round-1
 * reasoning back into the round-2 deliberation prompt).
 */
function renderEntriesForPrompt(entries: IVoteEntry[]): string[] {
  return entries.map((e) => {
    const phaseTag = e.phase === 'round2' ? ' (deliberation)' : '';
    if (e.relevant === null) return `**${e.model}**${phaseTag}: (no response)`;
    return `**${e.model}**${phaseTag}: ${e.thought}`;
  });
}

/**
 * Render vote entries as PR-comment markdown, grouped by stance:
 * a "Valid finding" section for relevant=true votes and a "Not
 * important" section for relevant=false. No-response entries are
 * omitted (they carry no signal for the reader).
 */
export function formatValidationNotes(entries: IVoteEntry[]): string {
  const valid: IVoteEntry[] = [];
  const noise: IVoteEntry[] = [];
  for (const e of entries) {
    if (e.relevant === true) valid.push(e);
    else if (e.relevant === false) noise.push(e);
  }

  const render = (e: IVoteEntry): string => {
    const phaseTag = e.phase === 'round2' ? ' (deliberation)' : '';
    return `- **${e.model}**${phaseTag}: ${e.thought}`;
  };

  const blocks: string[] = [];
  if (valid.length > 0) {
    blocks.push(['**Valid finding:**', ...valid.map(render)].join('\n'));
  }
  if (noise.length > 0) {
    blocks.push(['**Not important:**', ...noise.map(render)].join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Pick up to `n` random items from `items`, without replacement, preserving
 * the original items as-is (no deep clone). Returns a fresh array. When
 * `n <= 0` or `items.length <= n`, returns all items in a shallow copy
 * (no pick is needed). Used by [[MultiModelValidator.withRandomSubset]] and
 * by the reviewer to cap the review-model pool per PR.
 */
export function pickRandom<T>(items: T[], n: number): T[] {
  if (n <= 0 || items.length <= n) return [...items];
  // Fisher–Yates partial shuffle to pick n items uniformly at random.
  const arr = [...items];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

/**
 * Whether `modelName` produced this finding, and so must not vote on it. A
 * merged finding (from FindingDeduplicator) lists every contributing author in
 * `contributingAuthors`; plain findings fall back to the single `author`.
 */
function isAuthoredBy(finding: IAuthoredFinding, modelName: string): boolean {
  if (finding.contributingAuthors && finding.contributingAuthors.length > 0) {
    return finding.contributingAuthors.includes(modelName);
  }
  return finding.author === modelName;
}

export class MultiModelValidator {
  constructor(private readonly models: LlmClient[]) {}

  public get hasModels(): boolean {
    return this.models.length > 0;
  }

  /** Names of the models in this validator's active pool — used for logging the per-PR random pick. */
  public get modelNames(): string[] {
    return this.models.map((m) => m.name);
  }

  /**
   * Return a fresh validator instance whose active pool is a random subset of
   * this instance's pool, of size at most `n`. Use this once per PR to limit
   * how many validators vote on a given review (different PRs may see
   * different subsets — bounded cost with diversity over time). When `n <= 0`
   * the full pool is reused without subsetting.
   *
   * `deprioritizeNames` lists models to avoid sampling when possible — pass the
   * PR's review models, since a model can't vote on findings it authored, so
   * sampling a reviewer wastes a validator slot. Preferred (non-deprioritized)
   * models fill the subset first; deprioritized ones are used only to reach `n`.
   */
  public withRandomSubset(n: number, deprioritizeNames: string[] = []): MultiModelValidator {
    if (n <= 0) return this;
    if (deprioritizeNames.length === 0) {
      return new MultiModelValidator(pickRandom(this.models, n));
    }
    const deprioritized = new Set(deprioritizeNames);
    const preferred = this.models.filter((m) => !deprioritized.has(m.name));
    const picked = pickRandom(preferred, n);
    if (picked.length < n) {
      const fallback = this.models.filter((m) => deprioritized.has(m.name));
      picked.push(...pickRandom(fallback, n - picked.length));
    }
    return new MultiModelValidator(picked);
  }

  public async validateFindings(
    findings: IAuthoredFinding[],
    diffContext: string,
    fileContentByPath: Map<string, string>,
    existingComments?: string[],
    additionalContextByFile?: Map<string, string>,
    followUpGather?: IFollowUpInfoGatherer,
  ): Promise<IValidationResult> {
    if (findings.length === 0 || this.models.length === 0) {
      return {
        findings: findings.map((f) => ({ ...f, validationNotes: '' })),
        usage: [],
        discardedRound1: 0,
        discardedRound2: 0,
      };
    }

    const allUsage: IModelUsage[] = [];
    const allIndices = findings.map((_, i) => i);
    const groups = this.buildValidationGroups(
      findings,
      allIndices,
      fileContentByPath,
      diffContext,
      additionalContextByFile,
    );
    const round1Votes = await this.collectVotes(findings, groups, existingComments, allUsage);

    const unanimous: IValidatedFinding[] = [];
    const splitIndices: number[] = [];
    let discardedRound1 = 0;

    for (let i = 0; i < findings.length; i++) {
      const votes = round1Votes.get(i);
      const notes = votes ? formatValidationNotes(votes.entries) : '';
      if (!votes || votes.totalResponses === 0) {
        unanimous.push({ ...findings[i], validationNotes: notes });
      } else if (votes.votes === votes.totalResponses) {
        unanimous.push({ ...findings[i], validationNotes: notes });
      } else if (votes.votes === 0) {
        LogSink.debug(`Finding ${i} filtered (round 1): all voters say noise`, TraceTags.PI);
        discardedRound1++;
      } else {
        splitIndices.push(i);
      }
    }

    if (splitIndices.length === 0) {
      return { findings: unanimous, usage: allUsage, discardedRound1, discardedRound2: 0 };
    }

    LogSink.info(`${splitIndices.length} finding(s) have split votes, running deliberation round`, TraceTags.PI);

    // Between rounds, harvest "I need more context" requests from the round-1
    // votes on the contested findings, group them by the finding's file, and
    // feed that map to a second info-gather pass. The new per-file blobs are
    // merged into the original additionalContextByFile for round 2 (no
    // separate budget — same cap).
    let mergedContextByFile = new Map<string, string>(additionalContextByFile ?? []);
    if (followUpGather) {
      const requestsByFile = this.collectInfoRequestsByFile(findings, round1Votes, splitIndices);
      if (requestsByFile.size > 0) {
        try {
          const follow = await followUpGather(requestsByFile);
          allUsage.push(...follow.usage);
          if (follow.contextByFile.size > 0) {
            mergedContextByFile = this.mergeContextMaps(mergedContextByFile, follow.contextByFile);
            const totalChars = [...follow.contextByFile.values()].reduce((s, v) => s + v.length, 0);
            LogSink.info(
              `Follow-up info-gather added ${totalChars} chars across ${follow.contextByFile.size} file bucket(s) from ${requestsByFile.size} file(s) requesting info`,
              TraceTags.PI,
            );
          }
        } catch (err) {
          LogSink.warn(`Follow-up info-gather failed, continuing with original context: ${err}`, TraceTags.PI);
        }
      }
    }

    const { kept: deliberated, discarded: discardedRound2 } = await this.deliberate(
      findings,
      diffContext,
      fileContentByPath,
      splitIndices,
      round1Votes,
      allUsage,
      mergedContextByFile,
    );

    return {
      findings: [...unanimous, ...deliberated],
      usage: allUsage,
      discardedRound1,
      discardedRound2,
    };
  }

  /**
   * Group finding indices for validation. Every file we have whole-file
   * content for gets its own group with that content. Findings whose file
   * we couldn't fetch (lockfiles, deleted files, lookup failures) fall back
   * to a shared group carrying the diff — these are the only cases where
   * the validator may complain that the file "isn't in the diff".
   */
  private buildValidationGroups(
    findings: IAuthoredFinding[],
    indices: number[],
    fileContentByPath: Map<string, string>,
    diffContext: string,
    additionalContextByFile?: Map<string, string>,
  ): Array<{ context: string; indices: number[] }> {
    const byFile = new Map<string, number[]>();
    for (const i of indices) {
      const p = findings[i].filePath;
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p)!.push(i);
    }

    // Per-file gathered context: each group sees only the blocks the gatherer
    // produced for that specific file. Avoids dumping every finding's DTO
    // into every other finding's prompt.
    const ctxByFile = additionalContextByFile ?? new Map<string, string>();
    const extraFor = (p: string): string => {
      const specific = ctxByFile.get(p) ?? '';
      return specific.trim() ? `${specific}\n` : '';
    };

    const groups: Array<{ context: string; indices: number[] }> = [];
    const noContent: number[] = [];
    for (const [p, idxs] of byFile) {
      const content = fileContentByPath.get(p);
      if (content) {
        groups.push({
          context: `${extraFor(p)}## Full file \`${p}\`:\n\`\`\`\n${content.slice(0, 60000)}\n\`\`\`\n`,
          indices: idxs,
        });
      } else {
        noContent.push(...idxs);
      }
    }
    if (noContent.length > 0) {
      // Fallback group covers multiple files; concatenate each contributor's
      // per-file context so the validator can still see relevant info.
      const fallbackFiles = new Set(noContent.map((i) => findings[i].filePath));
      const fallbackExtras = [...fallbackFiles].map((p) => ctxByFile.get(p) ?? '').filter((s) => s.trim());
      const prefix = fallbackExtras.length > 0 ? `${fallbackExtras.join('\n')}\n` : '';
      groups.push({
        context: `${prefix}## Diff:\n\`\`\`\n${diffContext.slice(0, 8000)}\n\`\`\`\n`,
        indices: noContent,
      });
    }
    return groups;
  }

  /** Combine per-file context maps; later wins per file with newline-joined merge. */
  private mergeContextMaps(a: Map<string, string>, b: Map<string, string>): Map<string, string> {
    const out = new Map<string, string>(a);
    for (const [k, v] of b) {
      if (!v.trim()) continue;
      const existing = out.get(k);
      out.set(k, existing && existing.trim() ? `${existing}\n${v}` : v);
    }
    return out;
  }

  /**
   * Pull non-empty round-1 info requests for the contested findings, group
   * them by the finding's file path, and dedup within each file (the same DTO
   * request from N validators only needs to be fetched once for that group).
   */
  private collectInfoRequestsByFile(
    findings: IAuthoredFinding[],
    round1Votes: Map<number, IFindingVote>,
    splitIndices: number[],
  ): Map<string, string[]> {
    const out = new Map<string, { seen: Set<string>; reqs: string[] }>();
    for (const idx of splitIndices) {
      const votes = round1Votes.get(idx);
      if (!votes) continue;
      const { filePath } = findings[idx];
      const bucket = out.get(filePath) ?? { seen: new Set<string>(), reqs: [] };
      for (const e of votes.entries) {
        if (e.phase !== 'round1') continue;
        const req = (e.infoRequest ?? '').trim();
        if (!req || bucket.seen.has(req)) continue;
        bucket.seen.add(req);
        bucket.reqs.push(req);
      }
      if (bucket.reqs.length > 0) out.set(filePath, bucket);
    }
    const result = new Map<string, string[]>();
    for (const [k, v] of out) result.set(k, v.reqs);
    return result;
  }

  /** Round 1: each model votes on each group's findings, excluding ones it authored. */
  private async collectVotes(
    findings: IAuthoredFinding[],
    groups: Array<{ context: string; indices: number[] }>,
    existingComments: string[] | undefined,
    usageOut: IModelUsage[],
  ): Promise<Map<number, IFindingVote>> {
    const votes: Map<number, IFindingVote> = new Map();
    const ensure = (gi: number): IFindingVote => {
      if (!votes.has(gi)) votes.set(gi, { entries: [], votes: 0, totalResponses: 0 });
      return votes.get(gi)!;
    };

    const commentContext =
      existingComments && existingComments.length > 0
        ? `\n## Existing PR comments (for context):\n${existingComments.slice(0, 20).join('\n---\n').slice(0, 4000)}\n`
        : '';

    const systemPrompt = [
      'You are a senior code reviewer validating automated findings.',
      'For EACH finding, decide if it is genuinely worth flagging.',
      'A finding is only worth posting if it is a real issue — be strict.',
      'Add a brief thought (1 sentence) explaining WHY it matters or why it is noise.',
      '',
      'You may also request ADDITIONAL CONTEXT via the `infoRequest` field. If the',
      'evidence in front of you is insufficient to judge a finding confidently,',
      'name the SPECIFIC artefact you need: a repo-relative file path',
      '(e.g. "src/dto/comparison-entry.ts") or a symbol to grep for',
      '(e.g. "interface ComparisonEntry"). Be precise — vague requests like',
      '"more context" produce nothing usable. Leave infoRequest as "" when no',
      'additional context is needed.',
      '',
      'Return JSON: { "results": [{ "index": 0, "relevant": true/false, "thought": "...", "infoRequest": "..." }, ...] }',
    ].join('\n');

    for (const group of groups) {
      for (const model of this.models) {
        const localIndices = group.indices.filter((gi) => !isAuthoredBy(findings[gi], model.name));
        if (localIndices.length === 0) continue;

        try {
          const userMessage = [
            group.context,
            commentContext,
            `## Findings:\n${JSON.stringify(
              localIndices.map((gi, local) => ({
                index: local,
                file: findings[gi].filePath,
                line: findings[gi].line,
                severity: findings[gi].severity,
                comment: findings[gi].comment,
              })),
            )}`,
          ].join('\n');

          const response = await model.chat(systemPrompt, userMessage, {
            jsonMode: true,
            jsonSchema: findingsValidationWithInfoJsonSchema,
          });
          usageOut.push(this.trackUsage(model, response));

          const responded = new Set<number>();
          // Lenient parse: try the with-info schema first. If a model (e.g. one
          // without strict structured-output support) omits infoRequest, fall
          // back to the base schema and synthesize an empty infoRequest so it
          // still gets a vote.
          let parsedResults: Array<{ index: number; relevant: boolean; thought: string; infoRequest: string }> | null =
            null;
          const withInfo = parseWithSchema(response.content, FindingsValidationWithInfoSchema);
          if (withInfo) {
            parsedResults = withInfo.results;
          } else {
            const lenient = parseWithSchema(response.content, FindingsValidationSchema);
            if (lenient) {
              parsedResults = lenient.results.map((r) => ({ ...r, infoRequest: '' }));
              LogSink.debug(`Validation: ${model.name} omitted infoRequest, accepted vote without it`, TraceTags.PI);
            }
          }
          if (parsedResults) {
            for (const r of parsedResults) {
              if (r.index < 0 || r.index >= localIndices.length) continue;
              responded.add(r.index);
              const gi = localIndices[r.index];
              const entry = ensure(gi);
              entry.entries.push({
                model: model.name,
                phase: 'round1',
                relevant: r.relevant,
                thought: r.thought,
                infoRequest: r.infoRequest,
              });
              entry.totalResponses++;
              if (r.relevant) entry.votes++;
            }
          } else {
            LogSink.warn(`Validation: ${model.name} returned unparseable response, abstaining`, TraceTags.PI);
          }
          for (let local = 0; local < localIndices.length; local++) {
            if (responded.has(local)) continue;
            ensure(localIndices[local]).entries.push({
              model: model.name,
              phase: 'round1',
              relevant: null,
              thought: '',
            });
          }
        } catch (err) {
          LogSink.warn(`Validation model ${model.name} failed: ${err}`, TraceTags.PI);
          for (const gi of localIndices)
            ensure(gi).entries.push({ model: model.name, phase: 'round1', relevant: null, thought: '' });
        }
      }
    }

    return votes;
  }

  /**
   * Round 2: re-ask split findings with peers' round-1 reasoning. Author still
   * excluded. Keep unless responders unanimously reject (any single defender keeps).
   */
  private async deliberate(
    findings: IAuthoredFinding[],
    diffContext: string,
    fileContentByPath: Map<string, string>,
    splitIndices: number[],
    round1Votes: Map<number, IFindingVote>,
    usageOut: IModelUsage[],
    additionalContextByFile?: Map<string, string>,
  ): Promise<{ kept: IValidatedFinding[]; discarded: number }> {
    const groups = this.buildValidationGroups(
      findings,
      splitIndices,
      fileContentByPath,
      diffContext,
      additionalContextByFile,
    );
    const round2Votes: Map<number, IFindingVote> = new Map();
    const ensure = (gi: number): IFindingVote => {
      if (!round2Votes.has(gi)) round2Votes.set(gi, { entries: [], votes: 0, totalResponses: 0 });
      return round2Votes.get(gi)!;
    };

    const systemPrompt = [
      'You are reconsidering code review findings where reviewers disagreed.',
      'Other reviewers saw the same finding and reached different conclusions — read their reasoning.',
      'Read their reasoning carefully, then make your final decision.',
      'A finding is only worth posting if it is a REAL issue that the developer should fix.',
      'Return JSON: { "results": [{ "index": 0, "relevant": true/false, "thought": "..." }, ...] }',
    ].join('\n');

    for (const group of groups) {
      for (const model of this.models) {
        const localIndices = group.indices.filter((gi) => !isAuthoredBy(findings[gi], model.name));
        if (localIndices.length === 0) continue;

        try {
          const userMessage = [
            group.context,
            `## Contested findings (reviewers disagreed):\n${JSON.stringify(
              localIndices.map((gi, local) => ({
                index: local,
                file: findings[gi].filePath,
                line: findings[gi].line,
                severity: findings[gi].severity,
                comment: findings[gi].comment,
                previousReviews: renderEntriesForPrompt(round1Votes.get(gi)?.entries ?? []),
              })),
              null,
              2,
            )}`,
          ].join('\n');

          const response = await model.chat(systemPrompt, userMessage, {
            jsonMode: true,
            jsonSchema: findingsValidationJsonSchema,
          });
          usageOut.push(this.trackUsage(model, response));

          const responded = new Set<number>();
          const parsed = parseWithSchema(response.content, FindingsValidationSchema);
          if (parsed) {
            for (const r of parsed.results) {
              if (r.index < 0 || r.index >= localIndices.length) continue;
              responded.add(r.index);
              const gi = localIndices[r.index];
              const entry = ensure(gi);
              entry.entries.push({ model: model.name, phase: 'round2', relevant: r.relevant, thought: r.thought });
              entry.totalResponses++;
              if (r.relevant) entry.votes++;
            }
          } else {
            LogSink.warn(`Deliberation: ${model.name} returned unparseable response, abstaining`, TraceTags.PI);
          }
          for (let local = 0; local < localIndices.length; local++) {
            if (responded.has(local)) continue;
            ensure(localIndices[local]).entries.push({
              model: model.name,
              phase: 'round2',
              relevant: null,
              thought: '',
            });
          }
        } catch (err) {
          LogSink.warn(`Deliberation model ${model.name} failed: ${err}`, TraceTags.PI);
          for (const gi of localIndices)
            ensure(gi).entries.push({ model: model.name, phase: 'round2', relevant: null, thought: '' });
        }
      }
    }

    const kept: IValidatedFinding[] = [];
    let discarded = 0;
    for (const idx of splitIndices) {
      const r1 = round1Votes.get(idx);
      const r2 = round2Votes.get(idx);
      const allEntries = [...(r1?.entries ?? []), ...(r2?.entries ?? [])];

      const discard = !!r2 && r2.totalResponses > 0 && r2.votes === 0;
      if (discard) {
        LogSink.debug(`Finding ${idx} filtered after deliberation: all voters reject`, TraceTags.PI);
        discarded++;
      } else {
        kept.push({ ...findings[idx], validationNotes: formatValidationNotes(allEntries) });
      }
    }

    return { kept, discarded };
  }

  /**
   * Propose inline ` ```suggestion ` edits for the given findings using one
   * chat model (no pi runner, no container). Each suggestion may ONLY correct
   * natural-language text — spelling, grammar and wording in comments,
   * docstrings, doc/markdown files, and human-facing strings/log messages —
   * never executable code. The model is shown each finding plus that file's
   * ADDED lines (with their new-file numbers), and returns either a `replace`
   * over a contiguous range of those lines or a `skip`.
   *
   * Returns exactly one proposal per finding, index-aligned (missing or
   * malformed entries default to `skip`), so the caller can address proposals
   * by finding index. Range/added-line correctness is enforced by the caller
   * (isAddedRange) and the suggestion is gated by {@link validateSuggestions}.
   */
  public async proposeTextFixes(
    findings: IReviewFinding[],
    fullDiff: string,
  ): Promise<{ proposals: IFixProposal[]; usage: IModelUsage[] }> {
    if (this.models.length === 0 || findings.length === 0) {
      return { proposals: [], usage: [] };
    }

    const diffLines = fullDiff.split('\n');
    const addedByFile = new Map<string, Array<{ line: number; content: string }>>();
    const editableFor = (filePath: string): Array<{ line: number; content: string }> => {
      const cached = addedByFile.get(filePath);
      if (cached) return cached;
      const lines = extractAddedLines(diffLines, filePath);
      addedByFile.set(filePath, lines);
      return lines;
    };

    const items = findings.map((f, i) => ({
      index: i,
      file: f.filePath,
      findingLine: f.line,
      finding: f.comment.slice(0, 800),
      editableAddedLines: editableFor(f.filePath).map((l) => ({ line: l.line, text: l.content })),
    }));

    const system = [
      'You propose tiny, safe inline suggestion edits for code-review findings.',
      'You may ONLY fix natural-language text: spelling, grammar and wording in',
      '  - code comments and docstrings,',
      '  - documentation / markdown files,',
      '  - human-facing string literals and log messages.',
      'You must NEVER change executable code — not identifiers, keywords, operators,',
      'control flow, function signatures, API names, imports, types, or logic — not even',
      'to "improve" them. If the only useful fix would touch code, skip.',
      'For each finding, choose one action:',
      ' - "replace": the finding is a pure TEXT fix on a contiguous range of the listed',
      '   editableAddedLines. Set startLine/endLine to new-file line numbers FROM THAT LIST,',
      '   and replacement to the full corrected text for those lines — preserve all code,',
      '   indentation and surrounding characters exactly, changing only the natural-language text.',
      ' - "skip": anything else (a logic/code concern, "consider ...", architectural points,',
      '   or when the text to fix is not on an editable added line).',
      'Return JSON {"proposals":[{"index","action","startLine","endLine","replacement","reason"}]}.',
      'For "skip" set startLine and endLine to 0 and replacement to "". For "replace" set reason to "".',
    ].join('\n');

    const userMessage = `## Findings and editable lines:\n${JSON.stringify(items, null, 2)}`;

    // Default every finding to skip; the model upgrades the ones it can fix.
    const proposals: IFixProposal[] = findings.map((_, i) => ({
      action: 'skip',
      findingIndex: i,
      reason: 'no proposal returned',
    }));
    const usage: IModelUsage[] = [];

    const model = this.models[0];
    try {
      const response = await model.chat(system, userMessage, {
        jsonMode: true,
        jsonSchema: textFixProposalsJsonSchema,
      });
      usage.push(this.trackUsage(model, response));

      const parsed = parseWithSchema(response.content, TextFixProposalsSchema);
      if (parsed) {
        for (const p of parsed.proposals) {
          if (p.index < 0 || p.index >= findings.length) continue;
          const isUsableReplace =
            p.action === 'replace' && p.replacement !== '' && p.startLine > 0 && p.endLine >= p.startLine;
          if (isUsableReplace) {
            proposals[p.index] = {
              action: 'replace',
              findingIndex: p.index,
              replacement: p.replacement,
              startLine: p.startLine,
              endLine: p.endLine,
            };
          } else {
            proposals[p.index] = { action: 'skip', findingIndex: p.index, reason: p.reason || 'not a text fix' };
          }
        }
      }
    } catch (err) {
      LogSink.warn(`Text-fix proposal failed: ${err}`, TraceTags.PI);
    }

    return { proposals, usage };
  }

  /**
   * Council vote on proposed suggestions. Same unanimity-with-deliberation
   * rule as validateFindings: round 1 collects votes, splits go to round 2 with
   * peers' reasoning, and only suggestions that all responding validators approve
   * after round 2 are kept.
   */
  public async validateSuggestions(
    findings: IReviewFinding[],
    proposals: IFixProposal[],
    fileContextBySuggestion: Map<number, string>,
  ): Promise<ISuggestionValidationResult> {
    // Filter to replace-proposals that have file context.
    const eligible = proposals.filter(
      (p): p is Extract<IFixProposal, { action: 'replace' }> =>
        p.action === 'replace' && fileContextBySuggestion.has(p.findingIndex),
    );

    if (eligible.length === 0 || this.models.length === 0) {
      return {
        approvedSuggestions: new Map(),
        usage: [],
        discardedRound1: 0,
        discardedRound2: 0,
      };
    }

    const allUsage: IModelUsage[] = [];

    // Round 1: collect votes per eligible suggestion.
    const round1Votes = await this.collectSuggestionVotes(
      findings,
      eligible,
      fileContextBySuggestion,
      false, // round 1
      undefined,
      allUsage,
    );

    // Classify per eligible suggestion.
    const approved: Map<number, IFixProposal> = new Map();
    const splitIndices: number[] = [];
    let discardedRound1 = 0;

    for (let i = 0; i < eligible.length; i++) {
      const votes = round1Votes.get(i);
      if (!votes || votes.totalResponses === 0) {
        // No votes / all parsing failures → drop, no fallback approval.
        discardedRound1++;
        continue;
      }
      if (votes.votes === votes.totalResponses) {
        approved.set(eligible[i].findingIndex, eligible[i]);
      } else if (votes.votes === 0) {
        discardedRound1++;
      } else {
        splitIndices.push(i);
      }
    }

    if (splitIndices.length === 0) {
      return {
        approvedSuggestions: approved,
        usage: allUsage,
        discardedRound1,
        discardedRound2: 0,
      };
    }

    // Round 2: deliberate on contested suggestions, with peers' round-1 reasoning.
    LogSink.info(`${splitIndices.length} suggestion(s) have split votes, running deliberation round`, TraceTags.PI);
    const round2Votes = await this.collectSuggestionVotes(
      findings,
      splitIndices.map((i) => eligible[i]),
      fileContextBySuggestion,
      true, // round 2
      splitIndices.map((i) => renderEntriesForPrompt(round1Votes.get(i)?.entries ?? [])),
      allUsage,
    );

    let discardedRound2 = 0;
    for (let r2Idx = 0; r2Idx < splitIndices.length; r2Idx++) {
      const eligibleIdx = splitIndices[r2Idx];
      const votes = round2Votes.get(r2Idx);
      const unanimous = votes && votes.totalResponses > 0 && votes.votes === votes.totalResponses;
      if (unanimous) {
        approved.set(eligible[eligibleIdx].findingIndex, eligible[eligibleIdx]);
      } else {
        discardedRound2++;
      }
    }

    return {
      approvedSuggestions: approved,
      usage: allUsage,
      discardedRound1,
      discardedRound2,
    };
  }

  /**
   * Collect votes from each validator for a list of suggestions. The list is
   * indexed 0..N-1; the returned map keys correspond to that local index, NOT
   * to the original `findingIndex`. The caller maps back as needed.
   */
  private async collectSuggestionVotes(
    findings: IReviewFinding[],
    suggestions: Array<Extract<IFixProposal, { action: 'replace' }>>,
    fileContextBySuggestion: Map<number, string>,
    isRound2: boolean,
    round1NotesByLocalIndex: string[][] | undefined,
    usageOut: IModelUsage[],
  ): Promise<Map<number, IFindingVote>> {
    const votes: Map<number, IFindingVote> = new Map();

    const baseSystem = isRound2
      ? [
          'You are reconsidering a text-only suggestion where reviewers disagreed in round 1.',
          'Other reviewers saw the same proposal and reached different conclusions — read their reasoning.',
          'These suggestions may only correct natural-language text (comments, docstrings, docs, human-facing strings/log messages).',
          'Approve (relevant=true) ONLY if the replacement changes natural-language text and leaves all executable code byte-for-byte identical, and the correction is accurate.',
          'Reject (relevant=false) if it alters any code (identifiers, keywords, operators, control flow, signatures, imports, logic) or if the wording fix is wrong.',
          'Return JSON: { "results": [{ "index": 0, "relevant": true/false, "thought": "..." }, ...] }',
        ].join('\n')
      : [
          'You are a senior reviewer evaluating a proposed text-only suggestion.',
          'These suggestions may only correct natural-language text: spelling, grammar and wording in comments, docstrings, doc/markdown files, and human-facing string literals/log messages.',
          'For EACH suggestion, compare the proposedReplacement against the surrounding context line by line.',
          'Approve (relevant=true) ONLY if it changes natural-language text and leaves all executable code byte-for-byte identical (same indentation and surrounding characters), and the correction is actually right.',
          'Reject (relevant=false) if it changes any code (identifiers, keywords, operators, control flow, function signatures, imports, types, or logic), introduces a new issue, or the wording fix is incorrect.',
          'Add a brief thought (1 sentence) explaining why you approve or reject.',
          'Return JSON: { "results": [{ "index": 0, "relevant": true/false, "thought": "..." }, ...] }',
        ].join('\n');

    for (const model of this.models) {
      try {
        const items = suggestions.map((s, localIdx) => {
          const f = findings[s.findingIndex];
          const context = fileContextBySuggestion.get(s.findingIndex) ?? '';
          const block: Record<string, unknown> = {
            index: localIdx,
            file: f.filePath,
            findingLine: f.line,
            findingComment: f.comment.slice(0, 500),
            proposedRange: { startLine: s.startLine, endLine: s.endLine },
            proposedReplacement: s.replacement.slice(0, 4000),
            surroundingFileContext: context.slice(0, 12000),
          };
          if (isRound2 && round1NotesByLocalIndex) {
            block.previousReviews = round1NotesByLocalIndex[localIdx] ?? [];
          }
          return block;
        });

        const userMessage = `## Suggestions to evaluate:\n${JSON.stringify(items, null, 2)}`;

        const response = await model.chat(baseSystem, userMessage, {
          jsonMode: true,
          jsonSchema: findingsValidationJsonSchema,
        });
        usageOut.push(this.trackUsage(model, response));

        const parsed = parseWithSchema(response.content, FindingsValidationSchema);
        if (parsed) {
          for (const r of parsed.results) {
            if (r.index < 0 || r.index >= suggestions.length) continue;
            if (!votes.has(r.index)) votes.set(r.index, { entries: [], votes: 0, totalResponses: 0 });
            const entry = votes.get(r.index)!;
            entry.entries.push({
              model: model.name,
              phase: isRound2 ? 'round2' : 'round1',
              relevant: r.relevant,
              thought: r.thought,
            });
            entry.totalResponses++;
            if (r.relevant) entry.votes++;
          }
        } else {
          LogSink.warn(`Suggestion validation: ${model.name} returned unparseable response, abstaining`, TraceTags.PI);
        }
      } catch (err) {
        LogSink.warn(`Suggestion validation model ${model.name} failed: ${err}`, TraceTags.PI);
      }
    }

    return votes;
  }

  public async validateFix(userRequest: string, diff: string): Promise<IFixValidationResult> {
    if (this.models.length === 0) {
      return { approved: true, summary: 'No validation models configured.', usage: [] };
    }

    const allUsage: IModelUsage[] = [];
    const results: Array<{ model: string; needsChange: boolean; reason: string }> = [];

    for (const model of this.models) {
      try {
        const systemPrompt = [
          'You are reviewing a code fix.',
          `The user asked: ${JSON.stringify(userRequest.slice(0, 500))}`,
          'Review the diff. Return JSON: { "needsChange": true/false, "reason": "one paragraph" }',
          'Be honest: does this fix actually address the request and improve the code?',
        ].join('\n');

        const response = await model.chat(systemPrompt, `\`\`\`diff\n${diff.slice(0, 10000)}\n\`\`\``, {
          jsonMode: true,
          jsonSchema: fixValidationJsonSchema,
        });
        allUsage.push(this.trackUsage(model, response));

        const parsed = parseWithSchema(response.content, FixValidationSchema);
        if (parsed) {
          results.push({
            model: model.name,
            needsChange: parsed.needsChange,
            reason: parsed.reason,
          });
        } else {
          LogSink.warn(`Fix validation: ${model.name} returned unparseable response, abstaining`, TraceTags.PI);
        }
      } catch (err) {
        LogSink.warn(`Fix validation model ${model.name} failed: ${err}`, TraceTags.PI);
      }
    }

    if (results.length === 0) {
      return { approved: true, summary: 'No validators responded — skipping validation.', usage: allUsage };
    }

    const approved = results.every((r) => !r.needsChange);
    const summary = results.map((r) => `**${r.model}**: ${r.reason}`).join('\n');

    return { approved, summary, usage: allUsage };
  }

  public async summarizeFailure(feedbackHistory: string[]): Promise<{ summary: string; usage: IModelUsage[] }> {
    if (this.models.length === 0) return { summary: feedbackHistory.join('\n'), usage: [] };

    try {
      const response = await this.models[0].chat(
        'Summarize why this fix could not be approved. Be concise (2-3 sentences).',
        `Feedback from review rounds:\n${feedbackHistory.join('\n---\n')}`,
      );
      return {
        summary: response.content.slice(0, 500),
        usage: [this.trackUsage(this.models[0], response)],
      };
    } catch {
      return { summary: feedbackHistory.join('\n'), usage: [] };
    }
  }

  /**
   * Generate fix prompts for the review summary comment.
   * Model A drafts a prompt (one section per finding), model B reviews and amends.
   */
  public async generateFixPrompts(
    findings: IValidatedFinding[],
    diff: string,
    allComments: string[],
  ): Promise<{ prompt: string; usage: IModelUsage[] }> {
    if (this.models.length === 0 || findings.length === 0) {
      return { prompt: '', usage: [] };
    }

    const allUsage: IModelUsage[] = [];
    const context = this.buildFixPromptContext(findings, diff, allComments);

    // Step 1: model A drafts the prompt
    const draft = await this.draftFixPrompt(this.models[0], context, allUsage);
    if (!draft) return { prompt: '', usage: allUsage };

    // Step 2: model B (or model A if only one) reviews and amends
    const reviewer = this.models.length > 1 ? this.models[1] : this.models[0];
    const amended = await this.amendFixPrompt(reviewer, context, draft, allUsage);

    return { prompt: amended || draft, usage: allUsage };
  }

  /**
   * Generate a code-agent prompt for a rejected fix.
   * Model A drafts, model B amends.
   */
  public async generateRejectionPrompt(
    userRequest: string,
    diff: string,
    feedbackHistory: string[],
  ): Promise<{ prompt: string; usage: IModelUsage[] }> {
    if (this.models.length === 0) return { prompt: '', usage: [] };

    const allUsage: IModelUsage[] = [];

    // Step 1: model A drafts
    let draft: string | null = null;
    try {
      const response = await this.models[0].chat(
        [
          'You are writing a prompt for a code agent to fix issues that failed automated review.',
          'Write a clear, actionable prompt that the code agent can follow step by step.',
          'Include: what was requested, what went wrong, and exactly what needs to change.',
          'Be specific about files, lines, and expected behavior.',
        ].join('\n'),
        [
          `## Original request\n${userRequest}\n`,
          `## Diff that was rejected\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\`\n`,
          `## Rejection feedback\n${feedbackHistory.join('\n---\n')}`,
        ].join('\n'),
      );
      allUsage.push(this.trackUsage(this.models[0], response));
      draft = response.content;
    } catch (err) {
      LogSink.warn(`Rejection prompt draft failed: ${err}`, TraceTags.PI);
      return { prompt: '', usage: allUsage };
    }

    // Step 2: model B amends
    const reviewer = this.models.length > 1 ? this.models[1] : this.models[0];
    try {
      const response = await reviewer.chat(
        [
          'A colleague drafted a prompt for a code agent. Review it and improve it.',
          'Make it more precise: add file paths, line numbers, edge cases to handle.',
          'Remove vague instructions. Keep it actionable.',
          'Return the improved prompt as plain text (not JSON).',
        ].join('\n'),
        [
          `## Draft prompt\n${draft}\n`,
          `## Original context\nRequest: ${userRequest}\nFeedback: ${feedbackHistory.join('\n')}`,
        ].join('\n'),
      );
      allUsage.push(this.trackUsage(reviewer, response));
      return { prompt: response.content, usage: allUsage };
    } catch (err) {
      LogSink.warn(`Rejection prompt amendment failed, using draft: ${err}`, TraceTags.PI);
      return { prompt: draft, usage: allUsage };
    }
  }

  private buildFixPromptContext(findings: IValidatedFinding[], diff: string, allComments: string[]): string {
    const findingsBlock = findings
      .map((f, i) =>
        [
          `### Finding ${i + 1}: ${f.filePath}:${f.line} [${f.severity}]`,
          f.comment,
          f.validationNotes ? `Validator notes:\n${f.validationNotes}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');

    const commentsBlock =
      allComments.length > 0 ? `\n## PR comments\n${allComments.slice(0, 30).join('\n---\n').slice(0, 6000)}` : '';

    return [
      `## Diff\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\`\n`,
      `## Findings\n${findingsBlock}`,
      commentsBlock,
    ].join('\n');
  }

  private async draftFixPrompt(model: LlmClient, context: string, usageOut: IModelUsage[]): Promise<string | null> {
    try {
      const response = await model.chat(
        [
          'You are writing a prompt for a code agent to fix issues found in a code review.',
          'Write ONE section per finding. Each section should:',
          '1. State the file and line',
          '2. Explain what is wrong and why',
          '3. Give a clear, specific instruction on how to fix it',
          'Use the diff and validator feedback as context. Be precise — no vague instructions.',
          'Return the prompt as plain text (not JSON).',
        ].join('\n'),
        context,
      );
      usageOut.push(this.trackUsage(model, response));
      return response.content;
    } catch (err) {
      LogSink.warn(`Fix prompt draft failed: ${err}`, TraceTags.PI);
      return null;
    }
  }

  private async amendFixPrompt(
    model: LlmClient,
    context: string,
    draft: string,
    usageOut: IModelUsage[],
  ): Promise<string | null> {
    try {
      const response = await model.chat(
        [
          'A colleague drafted a prompt for a code agent to fix review findings.',
          'Review the draft and improve it:',
          '- Add missing file paths or line numbers',
          '- Correct any misunderstandings of the findings',
          '- Add edge cases or test scenarios to consider',
          '- Remove vague or redundant instructions',
          'Return the improved prompt as plain text (not JSON).',
        ].join('\n'),
        `## Draft prompt\n${draft}\n\n## Original context\n${context}`,
      );
      usageOut.push(this.trackUsage(model, response));
      return response.content;
    } catch (err) {
      LogSink.warn(`Fix prompt amendment failed, using draft: ${err}`, TraceTags.PI);
      return null;
    }
  }

  private trackUsage(model: LlmClient, response: { inputTokens: number; outputTokens: number }): IModelUsage {
    const cost =
      (response.inputTokens / 1_000_000) * model.inputCostPer1M +
      (response.outputTokens / 1_000_000) * model.outputCostPer1M;
    return {
      modelName: model.name,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costEur: cost,
    };
  }
}
