import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IGitProvider } from '../provider/provider';
import type { IComment, IInlineCommentInput } from '../provider/provider.types';
import { GitService } from './git.service';
import type { PiService, IFixProposal, IPiTokenUsage } from './pi.service';
import {
  splitDiffByFile,
  isDiffTooLarge,
  filterIgnoredFiles,
  splitFileDiffAtHunks,
  packDiffPatchesIntoBatches,
  isAddedRange,
  isLockfile,
} from './diff.utils';
import { CarrotConfigService } from '../config/carrot-config.service';
import type { IModelUsage, IAuthoredFinding } from '../types';
import { filterExcludedFindings } from './finding-filter';
import {
  MultiModelValidator,
  type IValidatedFinding,
  type IFollowUpInfoGatherer,
} from './multi-model-validator';
import { InfoGatherer, type IInfoTool, type ISearchHit } from './info-gatherer';
import { FindingDeduplicator } from './finding-deduplicator';
import { branchTimestamp, isBotComment } from '../constants';
import type { IMentionToolResult } from '../poller/mention-executor';
import type { ReviewPersona } from './personas';
import { PERSONA_DIRECTIVES } from './personas';

/** A model that performs the review pass via its pi-runner, with cost metadata for usage attribution. */
export interface IReviewModel {
  name: string;
  pi: PiService;
  roles: ReviewPersona[];
  inputCostPer1M: number;
  outputCostPer1M: number;
}

/** Group findings by `filePath`, preserving insertion order. */
export function groupFindingsByFile(findings: IAuthoredFinding[]): Map<string, IAuthoredFinding[]> {
  const out = new Map<string, IAuthoredFinding[]>();
  for (const f of findings) {
    const list = out.get(f.filePath);
    if (list) list.push(f);
    else out.set(f.filePath, [f]);
  }
  return out;
}

/** A single review pass: one model running one of its roles. */
export interface IReviewerRun {
  model: IReviewModel;
  role: ReviewPersona;
}

/** Flatten active reviewers into one run per (model, role) pair, in order. */
export function expandReviewerRuns(reviewers: IReviewModel[]): IReviewerRun[] {
  const runs: IReviewerRun[] = [];
  for (const model of reviewers) {
    for (const role of model.roles) {
      runs.push({ model, role });
    }
  }
  return runs;
}

/**
 * Parse `git grep -n` output into ISearchHit objects. Each non-empty line is
 * `path:line:content`. Lines that don't match are skipped silently — grep
 * occasionally emits diagnostic lines that aren't matches.
 */
export function parseGitGrepOutput(output: string): ISearchHit[] {
  const hits: ISearchHit[] = [];
  for (const raw of output.split('\n')) {
    if (!raw) continue;
    const m = /^([^:]+):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    hits.push({ file: m[1], line: parseInt(m[2], 10), snippet: m[3] });
  }
  return hits;
}

export function formatTokenFooter(usage: IModelUsage[]): string {
  const fmt = (n: number): string => n.toLocaleString('en-US');

  const aggregated = new Map<string, IModelUsage>();
  for (const u of usage) {
    const existing = aggregated.get(u.modelName);
    if (existing) {
      existing.inputTokens += u.inputTokens;
      existing.outputTokens += u.outputTokens;
      existing.costEur += u.costEur;
    } else {
      aggregated.set(u.modelName, { ...u });
    }
  }

  const totalCost = [...aggregated.values()].reduce((sum, u) => sum + u.costEur, 0);
  const parts = [...aggregated.values()].map(
    (u) => `${u.modelName}: ${fmt(u.inputTokens)} in / ${fmt(u.outputTokens)} out`,
  );
  const costLine = totalCost > 0 ? `~${totalCost.toFixed(4)} EUR 🥕` : 'n/a';

  const body = parts.length > 0 ? `${parts.join(' · ')} · ` : '';
  return ['---', `*${body}Est. cost: ${costLine}*`].join('\n');
}

/**
 * Post each inline comment best-effort: a single failed post (e.g. a comment
 * the provider rejects as out-of-diff) is logged and skipped instead of
 * aborting the whole review. Aborting would leave the PR's review state
 * unsaved, so the next poll would re-run the entire review and re-post every
 * comment — the duplicate-comment bug. Returns how many posted vs failed so the
 * caller can tell "nothing posted yet" (safe to retry) from "some posted"
 * (must lock in, no re-post).
 */
export async function postInlineCommentsBestEffort(
  inputs: IInlineCommentInput[],
  post: (input: IInlineCommentInput) => Promise<void>,
): Promise<{ posted: number; failed: number }> {
  let posted = 0;
  let failed = 0;
  for (const input of inputs) {
    try {
      await post(input);
      posted++;
    } catch (err) {
      failed++;
      LogSink.warn(
        `PR review: failed to post inline comment on ${input.path}:${input.line}, continuing: ${err}`,
        TraceTags.REVIEWER,
      );
    }
  }
  return { posted, failed };
}

/** Max number of existing comments included in the review prompt (most recent kept). */
const MAX_REVIEW_CONTEXT_COMMENTS = 60;

/**
 * Group existing PR comments into per-file markdown for the review prompt, so
 * the reviewers can see what's already been said and react ("that's been
 * fixed" / "still a problem") instead of blindly re-raising. File-anchored
 * comments are grouped by path; non-anchored comments go under a general
 * discussion block. Each comment is whitespace-collapsed and capped at 500
 * chars, and only the most recent MAX_REVIEW_CONTEXT_COMMENTS comments are
 * included — without the count cap, a long-discussed PR would multiply every
 * reviewer's prompt cost unboundedly. Returns an empty string when there is
 * nothing usable.
 */
export function formatExistingCommentsForReview(comments: IComment[]): string {
  // Keep the most recent comments (input is in API order, oldest first).
  const recent = comments.slice(-MAX_REVIEW_CONTEXT_COMMENTS);

  const byFile = new Map<string, string[]>();
  const general: string[] = [];
  for (const c of recent) {
    const text = c.text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) continue;
    if (c.anchor?.path) {
      const where = c.anchor.line ? ` (line ${c.anchor.line})` : '';
      const list = byFile.get(c.anchor.path);
      const line = `- ${c.authorUsername}${where}: ${text}`;
      if (list) list.push(line);
      else byFile.set(c.anchor.path, [line]);
    } else {
      general.push(`- ${c.authorUsername}: ${text}`);
    }
  }

  const blocks: string[] = [];
  if (comments.length > recent.length) {
    blocks.push(`*(${comments.length - recent.length} older comment(s) omitted)*`);
  }
  for (const [filePath, lines] of byFile) {
    blocks.push([`## Existing comments on \`${filePath}\`:`, ...lines].join('\n'));
  }
  if (general.length > 0) {
    blocks.push(['## General discussion:', ...general].join('\n'));
  }
  // A lone "omitted" marker with no actual comments carries no signal.
  return byFile.size === 0 && general.length === 0 ? '' : blocks.join('\n\n');
}

export class ReviewerService {
  private readonly provider: IGitProvider;
  private readonly git: GitService;
  private readonly reviewModels: IReviewModel[];
  private readonly botUsername: string;
  private readonly maxDiffLines: number;
  private readonly maxFileLines: number;
  private readonly multiValidator: MultiModelValidator;
  private readonly carrotConfigService: CarrotConfigService;
  private readonly infoGatherer: InfoGatherer;
  private readonly deduplicator: FindingDeduplicator;
  private readonly maxValidators: number;

  constructor(
    provider: IGitProvider,
    git: GitService,
    reviewModels: IReviewModel[],
    botUsername: string,
    maxDiffLines: number,
    maxFileLines: number,
    multiValidator: MultiModelValidator,
    carrotConfigService: CarrotConfigService,
    infoGatherer: InfoGatherer,
    deduplicator: FindingDeduplicator,
    maxValidators: number,
  ) {
    this.provider = provider;
    this.git = git;
    this.reviewModels = reviewModels;
    this.botUsername = botUsername;
    this.maxDiffLines = maxDiffLines;
    this.maxFileLines = maxFileLines;
    this.multiValidator = multiValidator;
    this.carrotConfigService = carrotConfigService;
    this.infoGatherer = infoGatherer;
    this.deduplicator = deduplicator;
    this.maxValidators = maxValidators;
  }

  /**
   * Per-PR validator: a fresh MultiModelValidator whose pool is a random
   * subset of the configured validators, capped at `maxValidators` (0 = no
   * cap). Reused across round 1 / round 2 / suggestion votes for the same
   * PR so all phases see the same models. `deprioritizeNames` (the PR's
   * finding authors) are avoided when possible so reviewers aren't sampled as
   * validators only to be excluded from their own findings.
   */
  private pickActiveValidator(deprioritizeNames: string[] = []): MultiModelValidator {
    return this.multiValidator.withRandomSubset(this.maxValidators, deprioritizeNames);
  }

  /** Pi-runner used for fix/propose/lint operations: the first review-enabled model. */
  private get primaryPi(): PiService | null {
    return this.reviewModels[0]?.pi ?? null;
  }

  /**
   * Build the IInfoTool the InfoGatherer uses to fetch additional context.
   * `readFile` goes through the provider (consistent with the existing validator
   * file-content path); `searchSymbol` runs `git grep` in the cloned repo. Both
   * swallow failures so a single missing file or empty grep doesn't abort the
   * gathering pass.
   */
  private buildInfoTool(project: string, slug: string, sourceBranch: string): IInfoTool {
    const repoDir = this.git.getRepoDir(project, slug);
    return {
      readFile: async (filePath: string) =>
        this.provider.getFileContent(project, slug, filePath, { at: sourceBranch, quiet: true }),
      searchSymbol: async (query: string): Promise<ISearchHit[]> => {
        if (!query.trim()) return [];
        try {
          const output = execFileSync('git', ['grep', '-n', '-I', '--max-count=5', '--', query], {
            cwd: repoDir,
            encoding: 'utf-8',
            maxBuffer: 2 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return parseGitGrepOutput(output);
        } catch {
          // `git grep` exits 1 when there are no matches; any other failure
          // (e.g. binary file count limit) should not block validation either.
          return [];
        }
      },
    };
  }

  /**
   * Attribute a pi-runner token usage to a review model, costed with that
   * model's rates. When `role` is given (the review pass), it's appended to the
   * displayed name (e.g. `Opus 4.8 (readability)`) so the footer breaks usage
   * down per role; fix/propose/lint runs omit it and show the plain name.
   */
  private toModelUsage(rm: IReviewModel, usage: IPiTokenUsage, role?: ReviewPersona): IModelUsage {
    return {
      modelName: role ? `${rm.name} (${role})` : rm.name,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costEur:
        (usage.inputTokens / 1_000_000) * rm.inputCostPer1M + (usage.outputTokens / 1_000_000) * rm.outputCostPer1M,
    };
  }

  public async reviewPr(
    project: string,
    slug: string,
    prId: number,
    targetBranch: string,
    sourceBranch: string,
    dockerImage?: string,
    rulesFiles?: string[],
    generateFixPrompts?: boolean,
  ): Promise<void> {
    LogSink.info(`Reviewing PR #${prId} in ${project}/${slug}`, TraceTags.REVIEWER);

    // Fetch existing PR comments once: the reviewers see them (so they react to
    // what's already been said instead of re-raising fixed issues), and
    // postFindings reuses them for validator context and fix prompts.
    const existingComments = await this.provider.getComments(project, slug, prId);
    const reviewCommentContext = formatExistingCommentsForReview(existingComments);

    let result: ReturnType<typeof this.runReview>;
    try {
      result = this.runReview(
        project,
        slug,
        prId,
        targetBranch,
        sourceBranch,
        reviewCommentContext,
        dockerImage,
        rulesFiles,
      );
    } catch (err) {
      LogSink.error(`PR #${prId}: review failed: ${err}`, TraceTags.REVIEWER);
      await this.postOrUpdateFailureComment(
        project,
        slug,
        prId,
        `Automated review failed: ${String(err).slice(0, 200)}`,
      );
      throw err;
    }
    if (!result) return;

    const { allFindings, reviewUsage, chunks, fullDiff } = result;

    // Pick the per-PR validator subset now (after the review) so we can prefer
    // validators that did NOT author findings here: a model can't vote on its
    // own finding, so sampling an author wastes a slot and often leaves a
    // finding with a single voter. Reused across all validation phases below.
    const authorNames = [...new Set(allFindings.map((f) => f.author))];
    const activeValidator = this.pickActiveValidator(authorNames);
    if (activeValidator.modelNames.length > 0) {
      LogSink.info(
        `PR #${prId}: active validators (${activeValidator.modelNames.length}): ${activeValidator.modelNames.join(', ')}`,
        TraceTags.REVIEWER,
      );
    }

    const repoDir = this.git.getRepoDir(project, slug);
    const { validationUsage, validatedFindings, allComments, discardedRound1, discardedRound2, skippedLargeFiles } =
      await this.postFindings(
        project,
        slug,
        prId,
        allFindings,
        chunks,
        fullDiff,
        sourceBranch,
        repoDir,
        activeValidator,
        existingComments,
        dockerImage,
      );

    // Best-effort: inline comments are already posted and the PR's review state
    // will be saved by the poller, so a failing summary must not throw here —
    // that would skip the state save and re-post every inline comment next poll.
    try {
      await this.postSummary(
        project,
        slug,
        prId,
        validatedFindings,
        fullDiff,
        allComments,
        reviewUsage,
        validationUsage,
        discardedRound1,
        discardedRound2,
        skippedLargeFiles,
        activeValidator,
        generateFixPrompts,
      );
    } catch (err) {
      LogSink.warn(`PR #${prId}: failed to post review summary, continuing: ${err}`, TraceTags.REVIEWER);
    }
  }

  private runReview(
    project: string,
    slug: string,
    prId: number,
    targetBranch: string,
    sourceBranch: string,
    reviewCommentContext: string,
    dockerImage?: string,
    rulesFiles?: string[],
  ): {
    allFindings: IAuthoredFinding[];
    reviewUsage: IModelUsage[];
    chunks: ReturnType<typeof splitDiffByFile>;
    fullDiff: string;
  } | null {
    this.git.cloneOrFetch(project, slug);

    const fullDiff = this.git.getDiff(project, slug, targetBranch, sourceBranch);
    if (!fullDiff.trim()) {
      LogSink.info(`PR #${prId}: no diff, skipping`, TraceTags.REVIEWER);
      return null;
    }

    if (this.reviewModels.length === 0) {
      LogSink.warn(`PR #${prId}: no review models configured, skipping review`, TraceTags.REVIEWER);
      return null;
    }

    const standards = this.loadCodeStandards(project, slug, targetBranch, rulesFiles);
    LogSink.debug(`PR #${prId}: code standards ${standards ? 'loaded' : 'not found'}`, TraceTags.REVIEWER);

    const chunks = filterIgnoredFiles(splitDiffByFile(fullDiff));
    const diffToReview = chunks.map((c) => c.content).join('\n');

    let reviewable: string[];
    if (isDiffTooLarge(diffToReview, this.maxDiffLines)) {
      LogSink.info(`PR #${prId}: diff too large, packing patches for review`, TraceTags.REVIEWER);
      const packCap = Math.min(this.maxDiffLines, 2000);
      const flatParts: string[] = [];
      for (const chunk of chunks) {
        if (!chunk.content.trim()) continue;
        if (isDiffTooLarge(chunk.content, packCap)) {
          flatParts.push(...splitFileDiffAtHunks(chunk.content, packCap));
        } else {
          flatParts.push(chunk.content);
        }
      }
      reviewable = packDiffPatchesIntoBatches(flatParts, packCap);
    } else {
      reviewable = [diffToReview];
    }

    if (reviewable.length === 0 || !reviewable.some((c) => c.trim())) {
      LogSink.info(`PR #${prId}: no reviewable chunk(s), skipping`, TraceTags.REVIEWER);
      return null;
    }

    // Every review-enabled model runs, each once per assigned role.
    const runs = expandReviewerRuns(this.reviewModels);
    LogSink.info(
      `PR #${prId}: ${runs.length} review run(s) across ${this.reviewModels.length} model(s): ` +
        `${runs.map((r) => `${r.model.name}/${r.role}`).join(', ')}`,
      TraceTags.REVIEWER,
    );

    const allFindings: IAuthoredFinding[] = [];
    const reviewUsage: IModelUsage[] = [];
    for (const { model: rm, role } of runs) {
      try {
        const batch = rm.pi.reviewBatch(reviewable, standards, reviewCommentContext, dockerImage, PERSONA_DIRECTIVES[role]);
        for (const f of batch.findings) {
          allFindings.push({ ...f, author: rm.name, persona: role });
        }
        reviewUsage.push(this.toModelUsage(rm, batch.usage, role));
      } catch (err) {
        LogSink.warn(`PR #${prId}: review model ${rm.name} (role ${role}) failed: ${err}`, TraceTags.REVIEWER);
      }
    }

    // Every review run errored — surface it as a failure rather than posting a
    // misleading "no issues found" summary. (A run that returns zero findings
    // still records usage, so an empty reviewUsage means nothing produced output.)
    if (reviewUsage.length === 0) {
      throw new Error(`all ${runs.length} review run(s) failed`);
    }

    if (allFindings.length === 0) {
      LogSink.info(
        `PR #${prId}: no issues found across ${runs.length} review run(s)`,
        TraceTags.REVIEWER,
      );
    }

    return { allFindings, reviewUsage, chunks, fullDiff };
  }

  private async postFindings(
    project: string,
    slug: string,
    prId: number,
    allFindings: IAuthoredFinding[],
    chunks: ReturnType<typeof splitDiffByFile>,
    fullDiff: string,
    sourceBranch: string,
    repoDir: string,
    activeValidator: MultiModelValidator,
    existingComments: IComment[],
    dockerImage?: string,
  ): Promise<{
    validationUsage: IModelUsage[];
    validatedFindings: IValidatedFinding[];
    allComments: string[];
    discardedRound1: number;
    discardedRound2: number;
    skippedLargeFiles: string[];
  }> {
    // Existing-comment dedup now happens upstream: the reviewers were shown all
    // existing comments and asked not to re-raise already-addressed issues, so
    // there is no mechanical post-filter here. `existingComments` is passed in
    // (fetched once in reviewPr) and reused for validator context and fix prompts.
    LogSink.info(
      `PR #${prId}: ${allFindings.length} finding(s) (pre-validation), ${existingComments.length} existing comment(s) shown to reviewers`,
      TraceTags.REVIEWER,
    );

    // 5b. Gather existing human comments as additional context so validators understand the PR discussion
    const humanComments = existingComments
      .filter((c) => !isBotComment(c.authorUsername, this.botUsername))
      .map(
        (c) =>
          `${c.authorUsername} on ${c.anchor?.path ?? 'general'}${c.anchor?.line ? `:${c.anchor.line}` : ''}: ${c.text.slice(0, 300)}`,
      );

    // 6. Exclusion filter: drop lockfile findings (silently) and findings on
    //    files over the line limit (recorded for the summary). Fetch file
    //    content once per distinct non-lockfile file; reuse it both for the
    //    line-count check and as whole-file validation context.
    const fileLineCounts = new Map<string, number>();
    const fileContentByPath = new Map<string, string>();
    const distinctFiles = [...new Set(allFindings.map((f) => f.filePath))];
    for (const filePath of distinctFiles) {
      if (isLockfile(filePath)) continue;
      const content = await this.provider.getFileContent(project, slug, filePath, {
        at: sourceBranch,
        quiet: true,
      });
      if (content === null) continue; // unknown line count -> not dropped
      fileLineCounts.set(filePath, content.split('\n').length);
      fileContentByPath.set(filePath, content);
    }

    const { kept: keptFindings, skippedLargeFiles } = filterExcludedFindings(
      allFindings,
      fileLineCounts,
      this.maxFileLines,
    );
    if (skippedLargeFiles.length > 0) {
      LogSink.info(
        `PR #${prId}: skipped ${skippedLargeFiles.length} file(s) over ${this.maxFileLines} lines: ${skippedLargeFiles.join(', ')}`,
        TraceTags.REVIEWER,
      );
    }

    const validationUsage: IModelUsage[] = [];

    // 5c. Same-run dedup: a single LLM pass collapses duplicate findings (often
    //     the same issue flagged by multiple review models) into one with a
    //     merged comment, BEFORE the validation council — so the council never
    //     votes on duplication. Fail-safe: any error keeps findings unmerged.
    const dedup = await this.deduplicator.dedupe(keptFindings);
    validationUsage.push(...dedup.usage);
    const dedupedFindings = dedup.findings;
    if (dedup.mergedClusters > 0) {
      LogSink.info(
        `PR #${prId}: dedup merged ${keptFindings.length - dedupedFindings.length} duplicate finding(s) into ${dedup.mergedClusters} cluster(s)`,
        TraceTags.REVIEWER,
      );
    }

    let validatedFindings: IValidatedFinding[] = dedupedFindings.map((f) => ({ ...f, validationNotes: '' }));
    let discardedRound1 = 0;
    let discardedRound2 = 0;
    if (dedupedFindings.length > 0) {
      // 6a. Info-gather: one dedicated LLM call per finding-file. Each call
      //     asks what extra files/symbols would help the validators judge
      //     THIS file's findings, then fetches them under the per-call budget.
      let additionalContextByFile = new Map<string, string>();
      let followUpGather: IFollowUpInfoGatherer | undefined;
      if (this.infoGatherer.isEnabled) {
        // git grep inside the gather tool reads the working tree, so we need
        // the repo checked out at the source branch's tip. This also makes
        // the subsequent proposeFixes reset idempotent.
        try {
          this.git.resetToRemoteBranch(project, slug, sourceBranch);
        } catch (err) {
          LogSink.warn(
            `PR #${prId}: could not reset to ${sourceBranch} before info-gather: ${err}`,
            TraceTags.REVIEWER,
          );
        }
        const infoTool = this.buildInfoTool(project, slug, sourceBranch);
        const findingsByFile = groupFindingsByFile(dedupedFindings);
        try {
          const gathered = await this.infoGatherer.gatherAll(findingsByFile, fullDiff, fileContentByPath, infoTool);
          additionalContextByFile = gathered.contextByFile;
          validationUsage.push(...gathered.usage);
          if (gathered.actionsApplied > 0) {
            const totalChars = [...gathered.contextByFile.values()].reduce((s, v) => s + v.length, 0);
            LogSink.info(
              `PR #${prId}: info-gatherer made ${findingsByFile.size} per-file call(s), added ${gathered.actionsApplied} context block(s) across ${gathered.contextByFile.size} file(s) (${totalChars} chars)`,
              TraceTags.REVIEWER,
            );
          }
        } catch (err) {
          LogSink.warn(`PR #${prId}: info-gathering failed, continuing without: ${err}`, TraceTags.REVIEWER);
        }

        // Follow-up callback: invoked by the validator between rounds when
        // round-1 voters asked for specific extra context (grouped by file).
        // One dedicated gather call per file with requests — same per-call
        // budget as the proactive pass.
        followUpGather = async (requestsByFile) => {
          try {
            const followUp = await this.infoGatherer.gatherAll(
              findingsByFile,
              fullDiff,
              fileContentByPath,
              infoTool,
              requestsByFile,
              true, // onlyRequested — don't re-gather files with no requests
            );
            return { contextByFile: followUp.contextByFile, usage: followUp.usage };
          } catch (err) {
            LogSink.warn(`PR #${prId}: follow-up info-gather failed: ${err}`, TraceTags.REVIEWER);
            return { contextByFile: new Map(), usage: [] };
          }
        };
      }

      try {
        const validation = await activeValidator.validateFindings(
          dedupedFindings,
          fullDiff,
          fileContentByPath,
          humanComments,
          additionalContextByFile,
          followUpGather,
        );
        validatedFindings = validation.findings;
        validationUsage.push(...validation.usage);
        discardedRound1 = validation.discardedRound1;
        discardedRound2 = validation.discardedRound2;
        if (validatedFindings.length < dedupedFindings.length) {
          LogSink.info(
            `PR #${prId}: validation filtered ${dedupedFindings.length - validatedFindings.length} finding(s)`,
            TraceTags.REVIEWER,
          );
        }
      } catch (err) {
        LogSink.warn(`PR #${prId}: finding validation failed, keeping all: ${err}`, TraceTags.REVIEWER);
      }
    }

    // 6b. Propose code suggestions for kept findings (validator-gated).
    let approvedSuggestions = new Map<number, IFixProposal>();
    if (validatedFindings.length > 0) {
      try {
        const carrotConfig = await this.carrotConfigService.getConfig(project, slug);
        const suggestEnabled = carrotConfig?.suggestCodeFixes !== false;
        const primaryModel = this.reviewModels[0];
        if (suggestEnabled && primaryModel) {
          this.git.resetToRemoteBranch(project, slug, sourceBranch);
          const { proposals, usage: proposeUsage } = primaryModel.pi.proposeFixes(
            validatedFindings,
            repoDir,
            dockerImage,
          );

          // Build file-context map for replace-proposals only.
          const replaceProposals = proposals.filter(
            (p): p is Extract<IFixProposal, { action: 'replace' }> => p.action === 'replace',
          );

          const fileContextMap = new Map<number, string>();
          const diffLinesForRange = fullDiff.split('\n');
          for (const p of replaceProposals) {
            const finding = validatedFindings[p.findingIndex] as IValidatedFinding | undefined;
            if (!finding) continue;
            // Drop proposals whose range isn't all ADDED diff lines.
            if (!isAddedRange(diffLinesForRange, finding.filePath, p.startLine, p.endLine)) {
              continue;
            }
            const fileContent = await this.provider.getFileContent(project, slug, finding.filePath, {
              at: sourceBranch,
              quiet: true,
            });
            if (fileContent === null) continue;
            const fileLines = fileContent.split('\n');
            const sliceStart = Math.max(0, p.startLine - 1 - 300);
            const sliceEnd = Math.min(fileLines.length, p.endLine + 300);
            fileContextMap.set(p.findingIndex, fileLines.slice(sliceStart, sliceEnd).join('\n'));
          }

          // validateSuggestions internally filters replaceProposals to those with
          // entries in fileContextMap (i.e., proposals that survived isAddedRange).
          if (fileContextMap.size > 0) {
            // Proposals (code suggestions) get a single validator deciding whether
            // they're worth posting — not the full council used for findings.
            const suggestionValidator = activeValidator.withRandomSubset(1);
            const result = await suggestionValidator.validateSuggestions(
              validatedFindings,
              replaceProposals,
              fileContextMap,
            );
            approvedSuggestions = result.approvedSuggestions;
            validationUsage.push(...result.usage);
            LogSink.info(
              `PR #${prId}: suggestion validator (${suggestionValidator.modelNames.join(', ')}) approved ${result.approvedSuggestions.size}, discarded ${result.discardedRound1} round 1 + ${result.discardedRound2} round 2`,
              TraceTags.REVIEWER,
            );
          }

          // Attribute the proposeFixes pi-runner cost to the primary review model
          // so it shows up in the summary footer (not just the debug log).
          validationUsage.push(this.toModelUsage(primaryModel, proposeUsage));
          LogSink.debug(
            `PR #${prId}: pi proposeFixes used ${proposeUsage.inputTokens}/${proposeUsage.outputTokens} tokens`,
            TraceTags.REVIEWER,
          );
        }
      } catch (err) {
        LogSink.warn(`PR #${prId}: suggestion proposal/validation failed: ${err}`, TraceTags.REVIEWER);
      }
    }

    // 7. Build a map of renamed files from diff chunks and post inline comments
    const renameMap = new Map<string, string>();
    for (const chunk of chunks) {
      if (chunk.oldPath) renameMap.set(chunk.filePath, chunk.oldPath);
    }

    const diffLines = fullDiff.split('\n');
    const inputs: IInlineCommentInput[] = [];
    for (let i = 0; i < validatedFindings.length; i++) {
      const finding = validatedFindings[i];
      const lineType = this.detectLineType(diffLines, finding.filePath, finding.line);

      let severityPrefix: string;
      if (finding.severity === 'concern') {
        severityPrefix = '**Concern**';
      } else if (finding.severity === 'suggestion') {
        severityPrefix = '**Suggestion**';
      } else {
        severityPrefix = '**Note**';
      }

      const notesSuffix = finding.validationNotes
        ? `\n\n---\n${finding.validationNotes
            .split('\n')
            .map((n) => `> ${n}`)
            .join('\n')}`
        : '';

      const input: IInlineCommentInput = {
        text: '', // filled below
        path: finding.filePath,
        line: finding.line,
        lineKind: lineType.toLowerCase() as 'added' | 'removed' | 'context',
      };
      if (renameMap.has(finding.filePath)) {
        input.oldPath = renameMap.get(finding.filePath);
      }

      // Apply approved suggestion if present for this finding's index.
      let suggestionSuffix = '';
      const proposal = approvedSuggestions.get(i);
      if (proposal && proposal.action === 'replace') {
        suggestionSuffix = `\n\n\`\`\`suggestion\n${proposal.replacement}\n\`\`\``;
        input.line = proposal.endLine;
        input.suggestion = {
          replacement: proposal.replacement,
          startLine: proposal.startLine,
          endLine: proposal.endLine,
        };
      }

      input.text = `${severityPrefix}: ${finding.comment}${notesSuffix}${suggestionSuffix}`;
      inputs.push(input);
    }

    // Post best-effort: a single rejected comment must not abort the run, or the
    // PR's review state stays unsaved and the whole review re-posts next cycle.
    const { posted, failed } = await postInlineCommentsBestEffort(inputs, (commentInput) =>
      this.provider.postInlineComment(project, slug, prId, commentInput),
    );
    if (failed > 0) {
      LogSink.warn(`PR #${prId}: ${failed}/${inputs.length} inline comment(s) failed to post`, TraceTags.REVIEWER);
    }
    // Retry only when we had findings but posted nothing (transient failure):
    // throwing leaves the PR un-stated so the poller re-reviews — and since
    // nothing was posted, that retry can't create duplicates. Once any comment
    // posts, we return normally so the poller saves state (no re-post).
    if (inputs.length > 0 && posted === 0) {
      throw new Error(`failed to post all ${inputs.length} inline comment(s); will retry next cycle`);
    }

    // Collect all comments (bot + human) as context for fix prompt generation
    const allComments = existingComments.map(
      (c) =>
        `${c.authorUsername} on ${c.anchor?.path ?? 'general'}${c.anchor?.line ? `:${c.anchor.line}` : ''}: ${c.text.slice(0, 300)}`,
    );

    return { validationUsage, validatedFindings, allComments, discardedRound1, discardedRound2, skippedLargeFiles };
  }

  private async postSummary(
    project: string,
    slug: string,
    prId: number,
    validatedFindings: IValidatedFinding[],
    fullDiff: string,
    allComments: string[],
    reviewUsage: IModelUsage[],
    validatorUsage: IModelUsage[],
    discardedRound1: number,
    discardedRound2: number,
    skippedLargeFiles: string[],
    activeValidator: MultiModelValidator,
    generateFixPrompts?: boolean,
  ): Promise<void> {
    const n = validatedFindings.length;
    const concerns = validatedFindings.filter((f) => f.severity === 'concern').length;
    const suggestions = validatedFindings.filter((f) => f.severity === 'suggestion').length;
    const notes = validatedFindings.filter((f) => f.severity === 'note').length;

    const header = n === 0 ? 'Automated review: no issues found' : `Automated review: ${n} finding(s)`;
    const breakdown =
      n === 0
        ? 'Automated review reported no issues.'
        : `${concerns} concern(s), ${suggestions} suggestion(s), ${notes} note(s) — see inline comments for details.`;

    const skippedLine =
      skippedLargeFiles.length > 0
        ? `\n\n*${skippedLargeFiles.length} file(s) skipped: over ${this.maxFileLines} lines:*\n${skippedLargeFiles.map((p) => `- \`${p}\``).join('\n')}`
        : '';

    let fixPromptsSection = '';
    if (generateFixPrompts) {
      const fixableFindings = validatedFindings.filter((f) => f.severity === 'concern' || f.severity === 'suggestion');
      if (fixableFindings.length > 0) {
        try {
          const { prompt, usage } = await activeValidator.generateFixPrompts(fixableFindings, fullDiff, allComments);
          validatorUsage.push(...usage);
          if (prompt) {
            fixPromptsSection = `\n\n---\n**Fix prompt for code agent:**\n\`\`\`\n${prompt}\n\`\`\``;
          }
        } catch (err) {
          LogSink.warn(`PR #${prId}: fix prompt generation failed: ${err}`, TraceTags.REVIEWER);
        }
      }
    }

    const totalDiscarded = discardedRound1 + discardedRound2;
    const discardLine =
      totalDiscarded > 0
        ? `\n\n*Validators discarded ${totalDiscarded} finding(s) (${discardedRound1} round 1, ${discardedRound2} round 2)*`
        : '';

    const footer = formatTokenFooter([...reviewUsage, ...validatorUsage]);
    const commentBody = `${header}\n\n${breakdown}${skippedLine}${fixPromptsSection}${discardLine}\n\n${footer}`;
    await this.provider.postGeneralComment(project, slug, prId, commentBody);
  }

  public async fixPr(
    project: string,
    slug: string,
    prId: number,
    sourceBranch: string,
    targetBranch: string,
    userMessage: string,
    dockerImage?: string,
    generateFixPrompts?: boolean,
  ): Promise<IMentionToolResult> {
    LogSink.info(`Fixing PR #${prId}: ${userMessage}`, TraceTags.REVIEWER);

    const { diff, repoDir } = this.prepareRepoForFix(project, slug, sourceBranch, targetBranch);
    LogSink.debug(`PR #${prId} fix: diff ${diff.split('\n').length} lines, repoDir=${repoDir}`, TraceTags.REVIEWER);

    const fixUsage: IModelUsage[] = [];
    const summary = await this.applyPiFix(project, slug, prId, diff, repoDir, userMessage, fixUsage, dockerImage);

    const { earlyReturn, usage: loopUsage } = await this.validateFixWithLoop(
      prId,
      project,
      slug,
      userMessage,
      diff,
      repoDir,
      dockerImage,
      generateFixPrompts,
    );
    fixUsage.push(...loopUsage);
    const costFooter = `\n\n${formatTokenFooter(fixUsage)}`;
    if (earlyReturn) return { success: false, message: `${earlyReturn}${costFooter}` };

    const message = await this.createFixBranchAndPr(project, slug, prId, summary, userMessage, sourceBranch, 'fix');
    return { success: true, message: `${message}${costFooter}` };
  }

  private prepareRepoForFix(
    project: string,
    slug: string,
    sourceBranch: string,
    targetBranch: string,
  ): { diff: string; repoDir: string } {
    this.git.cloneOrFetch(project, slug);
    this.git.resetToRemoteBranch(project, slug, sourceBranch);
    const diff = this.git.getDiff(project, slug, targetBranch, sourceBranch);
    const repoDir = this.git.getRepoDir(project, slug);
    return { diff, repoDir };
  }

  private async applyPiFix(
    project: string,
    slug: string,
    prId: number,
    diff: string,
    repoDir: string,
    message: string,
    usageOut: IModelUsage[],
    dockerImage?: string,
  ): Promise<string | null> {
    const primaryModel = this.reviewModels[0];
    if (!primaryModel) {
      LogSink.warn(`PR #${prId}: no review-enabled model configured for fix operations`, TraceTags.REVIEWER);
      throw new Error('No review-enabled model configured for fix operations.');
    }
    try {
      const { summary, usage } = primaryModel.pi.fix(diff, repoDir, message, dockerImage);
      usageOut.push(this.toModelUsage(primaryModel, usage));
      LogSink.info(`PR #${prId}: pi fix returned summary: ${(summary ?? '(null)').slice(0, 200)}`, TraceTags.REVIEWER);
      return summary;
    } catch (err) {
      LogSink.error(`PR #${prId}: fix failed: ${err}`, TraceTags.REVIEWER);
      await this.provider.postGeneralComment(project, slug, prId, `Automated fix failed. Will retry next cycle.`);
      throw err;
    }
  }

  /**
   * Validates fix changes with a 3-round improvement loop using multi-model validation.
   * Returns an early-exit string if the fix should be aborted, or null to continue.
   */
  private async validateFixWithLoop(
    prId: number,
    project: string,
    slug: string,
    userMessage: string,
    originalDiff: string,
    repoDir: string,
    dockerImage: string | undefined,
    generateFixPrompts?: boolean,
  ): Promise<{ earlyReturn: string | null; usage: IModelUsage[] }> {
    if (!this.multiValidator.hasModels) {
      return { earlyReturn: null, usage: [] };
    }

    // Pick the validator subset once for the whole 3-round fix loop so every
    // round sees the same validators (a model can't flip-flop just because a
    // different sample voted).
    const activeValidator = this.pickActiveValidator();
    LogSink.info(
      `PR #${prId} fix: active validators (${activeValidator.modelNames.length}): ${activeValidator.modelNames.join(', ')}`,
      TraceTags.REVIEWER,
    );

    const primaryModel = this.reviewModels[0];
    const allUsage: IModelUsage[] = [];
    const feedbackHistory: string[] = [];

    for (let round = 1; round <= 3; round++) {
      // Check if pi made any changes
      const status = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf-8' }).trim();
      if (!status) {
        return {
          earlyReturn: 'No changes were needed.',
          usage: allUsage,
        };
      }

      const currentDiff = execSync('git diff', { cwd: repoDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      const result = await activeValidator.validateFix(userMessage, currentDiff);
      allUsage.push(...result.usage);

      if (result.approved) {
        LogSink.info(`PR #${prId}: fix approved by validators (round ${round})`, TraceTags.REVIEWER);
        return { earlyReturn: null, usage: allUsage };
      }

      feedbackHistory.push(`Round ${round}: ${result.summary}`);

      if (round < 3) {
        LogSink.info(`PR #${prId}: validators request changes (round ${round}), revising...`, TraceTags.REVIEWER);
        // Reset and let pi try again with feedback
        execSync('git checkout -- .', { cwd: repoDir, stdio: 'pipe' });
        execSync('git clean -fd', { cwd: repoDir, stdio: 'pipe' });
        if (!primaryModel) break;
        try {
          const revision = primaryModel.pi.fix(
            originalDiff,
            repoDir,
            `Previous attempt feedback:\n${result.summary}\n\nOriginal request: ${userMessage}`,
            dockerImage,
          );
          allUsage.push(this.toModelUsage(primaryModel, revision.usage));
        } catch (err) {
          LogSink.error(`PR #${prId}: pi revision failed in round ${round}: ${err}`, TraceTags.REVIEWER);
          break;
        }
      }
    }

    // All rounds exhausted -- summarize failure + generate fix prompt for manual use
    const failure = await activeValidator.summarizeFailure(feedbackHistory);
    allUsage.push(...failure.usage);

    let rejectionPrompt = '';
    if (generateFixPrompts) {
      try {
        const lastDiff = execSync('git diff', { cwd: repoDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
        const { prompt, usage } = await activeValidator.generateRejectionPrompt(userMessage, lastDiff, feedbackHistory);
        allUsage.push(...usage);
        if (prompt) {
          rejectionPrompt = `\n\n---\n**Suggested fix prompt:**\n\`\`\`\n${prompt}\n\`\`\``;
        }
      } catch (err) {
        LogSink.warn(`PR #${prId}: rejection prompt generation failed: ${err}`, TraceTags.REVIEWER);
      }
    }

    execSync('git checkout -- .', { cwd: repoDir, stdio: 'pipe' });
    execSync('git clean -fd', { cwd: repoDir, stdio: 'pipe' });
    return {
      earlyReturn: `Fix rejected after review: ${failure.summary}${rejectionPrompt}`,
      usage: allUsage,
    };
  }

  private async createFixBranchAndPr(
    project: string,
    slug: string,
    prId: number,
    summary: string | null,
    userMessage: string,
    sourceBranch: string,
    prefix: 'fix' | 'autofix',
  ): Promise<string> {
    const commitMsg =
      prefix === 'autofix'
        ? `fix: autofix ${(summary ?? 'applied review suggestions').slice(0, 60)}`
        : `fix: ${(summary ?? userMessage).slice(0, 72)}`;
    LogSink.info(`PR #${prId}: committing and pushing: ${commitMsg}`, TraceTags.REVIEWER);

    const ts = branchTimestamp();
    const fixBranch = `carrot/${prefix}-${prId}-${ts}`;
    this.git.createBranchCommitAndPush(project, slug, fixBranch, commitMsg);

    const description = prefix === 'autofix' ? (summary ?? 'Automated autofix.') : (summary ?? 'Automated fix.');
    const fixPrId = await this.provider.createFixPr(project, slug, commitMsg, description, fixBranch, sourceBranch);

    return `${prefix === 'autofix' ? 'Autofix' : 'Fix'} applied in PR #${fixPrId} (\`${fixBranch}\`): ${summary ?? 'Changes applied.'}`;
  }

  public async autofixPr(
    project: string,
    slug: string,
    prId: number,
    sourceBranch: string,
    targetBranch: string,
    dockerImage?: string,
    generateFixPrompts?: boolean,
  ): Promise<IMentionToolResult> {
    LogSink.info(`Autofix PR #${prId} in ${project}/${slug}`, TraceTags.REVIEWER);

    const { diff, repoDir } = this.prepareRepoForFix(project, slug, sourceBranch, targetBranch);

    if (!diff.trim()) {
      LogSink.info(`PR #${prId}: no diff for autofix`, TraceTags.REVIEWER);
      return { success: true, message: 'No diff to fix.' };
    }

    const fixMessage = await this.gatherReviewContext(project, slug, prId);
    const fixUsage: IModelUsage[] = [];
    const summary = await this.applyPiFix(project, slug, prId, diff, repoDir, fixMessage, fixUsage, dockerImage);

    const lintResult = this.runLintAndFixErrors(prId, repoDir, diff, fixUsage, dockerImage);

    const { earlyReturn, usage: loopUsage } = await this.validateFixWithLoop(
      prId,
      project,
      slug,
      fixMessage,
      diff,
      repoDir,
      dockerImage,
      generateFixPrompts,
    );
    fixUsage.push(...loopUsage);
    const costFooter = `\n\n${formatTokenFooter(fixUsage)}`;
    if (earlyReturn) return { success: false, message: `${earlyReturn}${costFooter}` };

    const result = await this.createFixBranchAndPr(project, slug, prId, summary, fixMessage, sourceBranch, 'autofix');
    const lintNote = lintResult.failed ? ' Lint errors were also addressed.' : '';
    return { success: true, message: `${result}${lintNote}${costFooter}` };
  }

  private async gatherReviewContext(project: string, slug: string, prId: number): Promise<string> {
    const existingComments = await this.provider.getComments(project, slug, prId);
    // Cap both count (most recent 50) and per-comment length — this text goes
    // verbatim into the pi fix prompt, so an unbounded comment history would
    // multiply the cost of the most expensive operation in the system.
    const reviewContext = existingComments
      .filter((c: IComment) => !isBotComment(c.authorUsername, this.botUsername) && c.anchor?.path)
      .slice(-50)
      .map((c: IComment) => `${c.anchor!.path}:${c.anchor!.line}: ${c.text.replace(/\s+/g, ' ').trim().slice(0, 500)}`)
      .join('\n');

    return reviewContext
      ? `Fix the issues found in this PR. Here are the review comments:\n${reviewContext}`
      : 'Fix any issues found in this PR based on the diff.';
  }

  private runLintAndFixErrors(
    prId: number,
    repoDir: string,
    diff: string,
    usageOut: IModelUsage[],
    dockerImage?: string,
  ): { failed: boolean; output: string } {
    const lintResult = this.runLint(repoDir, dockerImage);
    const primaryModel = this.reviewModels[0];
    if (lintResult.failed && lintResult.output && primaryModel) {
      LogSink.info(`PR #${prId}: lint failed after autofix, running pi to fix lint errors`, TraceTags.REVIEWER);
      try {
        const lintFix = primaryModel.pi.fix(
          diff,
          repoDir,
          `The linter found errors after applying fixes. ONLY FIX THE LINT ERRORS below. Do NOT touch warnings. Do NOT make any other changes.\n\nLint output:\n${lintResult.output.slice(0, 8000)}`,
          dockerImage,
        );
        usageOut.push(this.toModelUsage(primaryModel, lintFix.usage));
      } catch (err) {
        LogSink.warn(`PR #${prId}: lint fix attempt failed: ${err}`, TraceTags.REVIEWER);
      }
    }
    return lintResult;
  }

  private runLint(repoDir: string, dockerImage?: string): { failed: boolean; output: string } {
    const { primaryPi } = this;
    if (!primaryPi) return { failed: false, output: '' };
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8'));
    } catch {
      // No package.json or invalid JSON → no lint to run.
      return { failed: false, output: '' };
    }
    const script = pkg.scripts?.['ci:lint']
      ? 'ci:lint'
      : pkg.scripts?.['ci:stylecheck']
        ? 'ci:stylecheck'
        : pkg.scripts?.lint
          ? 'lint'
          : null;
    if (!script) return { failed: false, output: '' };

    LogSink.debug(`Running lint in Docker: npm run ${script}`, TraceTags.REVIEWER);
    return primaryPi.runLint(repoDir, script, dockerImage);
  }

  /**
   * Post a failure comment or update an existing one to avoid spam.
   * Finds the bot's existing "Automated review failed" comment and updates it in-place.
   */
  private async postOrUpdateFailureComment(project: string, slug: string, prId: number, text: string): Promise<void> {
    const safe = this.git.redactPat(text);
    const comments = await this.provider.getComments(project, slug, prId);
    const existing = comments.find(
      (c) => isBotComment(c.authorUsername, this.botUsername) && c.text.includes('Automated review failed'),
    );

    if (existing) {
      await this.provider.updateComment(project, slug, prId, existing.id, safe);
    } else {
      await this.provider.postGeneralComment(project, slug, prId, safe);
    }
  }

  private loadCodeStandards(project: string, slug: string, branch: string, rulesFiles?: string[]): string | null {
    const defaults = ['CLAUDE.md', 'AGENTS.md'];
    // Use configured files (with lowercase variants), or defaults
    const base = rulesFiles && rulesFiles.length > 0 ? rulesFiles : defaults;
    const candidates = [...new Set([...base, ...base.map((f) => f.toLowerCase())])];
    const parts: string[] = [];

    for (const file of candidates) {
      const content = this.git.getFileFromBranch(project, slug, branch, file);
      if (content) {
        parts.push(`# Code Standards from ${file}\n\n${content}`);
      }
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
  }

  private detectLineType(diffLines: string[], filePath: string, line: number): string {
    // `line` is the new-file line number. We only track the new-file line counter.
    let inFile = false;
    let newLine = 0;

    for (const diffLine of diffLines) {
      if (diffLine.startsWith('+++ b/')) {
        inFile = diffLine === `+++ b/${filePath}`;
        continue;
      }
      if (diffLine.startsWith('--- ')) continue;

      if (!inFile) continue;

      const hunkMatch = diffLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunkMatch) {
        newLine = parseInt(hunkMatch[1], 10);
        continue;
      }

      if (diffLine.startsWith('-')) {
        // Removed lines only exist in old file, no new-file line number
        continue;
      }

      if (diffLine.startsWith('+')) {
        if (newLine === line) return 'ADDED';
        newLine++;
        continue;
      }

      // Context line — exists in both files
      if (newLine === line) return 'CONTEXT';
      newLine++;
    }

    return 'CONTEXT';
  }
}
