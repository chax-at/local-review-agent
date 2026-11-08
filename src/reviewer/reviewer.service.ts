import { execFileSync } from 'child_process';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IGitProvider } from '../provider/provider';
import type { IComment, IInlineCommentInput } from '../provider/provider.types';
import { GitService } from './git.service';
import type { PiService, IPiTokenUsage, IPiVerificationEntry } from './pi.service';
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
  type IFixProposal,
  type IPiVerifier,
} from './multi-model-validator';
import { InfoGatherer, type IInfoTool, type ISearchHit } from './info-gatherer';
import { ContextExplorer } from './context-explorer';
import { SecurityScanner } from './security-scanner';
import { attributionSuffix } from './finding-attribution';
import { buildPrInfoBlob, type ITicketInfo } from './pr-context';
import { JiraService, extractTicketKey } from '../jira/jira.service';
import { FindingDeduplicator } from './finding-deduplicator';
import { FailureExplainer } from './failure-explainer';
import { branchTimestamp, isBotComment } from '../constants';
import { hasBotReviewForCommit, reviewCommitMarker } from './review-marker';
import type { IMentionToolResult } from '../poller/mention-executor';
import type { ReviewPersona } from './personas';
import { PERSONA_DIRECTIVES, STANDARDS_REQUIRED_PERSONAS } from './personas';
import { runFixValidationLoop, runLintAndFixErrors, type IFixLoopDeps } from './fix-loop';
import { metricMeters, recordModelUsage, type ReviewOutcome } from '../instrumentation/metrics';
import { ATTR_VCS_CHANGE_ID, ATTR_VCS_REPOSITORY_NAME, runInRootSpan } from '../instrumentation/tracing';

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

/** Map global finding indices to pi's local 0..N-1 indexing for one verification call. */
export function buildPiVerificationInputs(
  findings: IAuthoredFinding[],
  splitIndices: number[],
): Array<{ index: number; filePath: string; line: number; comment: string }> {
  return splitIndices.map((gi, local) => ({
    index: local,
    filePath: findings[gi].filePath,
    line: findings[gi].line,
    comment: findings[gi].comment,
  }));
}

/** Remap a verification result keyed by pi's local indices back to the original global finding indices. */
export function mapVerificationResultsBack(
  localResults: Map<number, IPiVerificationEntry>,
  splitIndices: number[],
): Map<number, IPiVerificationEntry> {
  const out = new Map<number, IPiVerificationEntry>();
  for (const [local, entry] of localResults) {
    if (local < 0 || local >= splitIndices.length) continue;
    out.set(splitIndices[local], entry);
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
 * Drop runs whose persona audits the repo's own guideline files when the repo
 * has none (`hasStandards` false): a vegetable-police run without guidelines
 * has no law book to enforce, so it must not run at all.
 */
export function filterRunsByStandards(
  runs: IReviewerRun[],
  hasStandards: boolean,
): { active: IReviewerRun[]; skipped: IReviewerRun[] } {
  if (hasStandards) return { active: runs, skipped: [] };
  const active: IReviewerRun[] = [];
  const skipped: IReviewerRun[] = [];
  for (const run of runs) {
    (STANDARDS_REQUIRED_PERSONAS.has(run.role) ? skipped : active).push(run);
  }
  return { active, skipped };
}

/**
 * Personas that get static-scanner output (Semgrep/gitleaks) attached as
 * context. `security` diagnoses it directly; `generic` covers security among
 * its broader focus. Every other persona is told to ignore security entirely,
 * so scanner output would just be noise for them.
 */
export const SCANNER_ELIGIBLE_PERSONAS: ReadonlySet<ReviewPersona> = new Set(['security', 'generic']);

/** Scanner findings are only attached for personas that judge security — see `SCANNER_ELIGIBLE_PERSONAS`. */
export function scannerFindingsForRole(role: ReviewPersona, scannerFindings: string): string | null {
  return scannerFindings.trim() && SCANNER_ELIGIBLE_PERSONAS.has(role) ? scannerFindings : null;
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
  private readonly contextExplorer: ContextExplorer;
  private readonly securityScanner: SecurityScanner;
  private readonly jira: JiraService;
  private readonly failureExplainer: FailureExplainer;
  private readonly heartbeat: () => void;

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
    contextExplorer: ContextExplorer,
    securityScanner: SecurityScanner,
    jira: JiraService,
    /**
     * Liveness tick. Each pi run blocks the event loop for minutes (synchronous
     * spawnSync), so no timer can keep the container health signal fresh — the
     * review loop ticks between runs instead. Defaults to a no-op for tests.
     */
    heartbeat: () => void = () => {},
    /** Turns a review's final-attempt failure into a plain-language PR comment. Defaults to disabled (raw error text only). */
    failureExplainer: FailureExplainer = new FailureExplainer(null),
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
    this.contextExplorer = contextExplorer;
    this.securityScanner = securityScanner;
    this.jira = jira;
    this.heartbeat = heartbeat;
    this.failureExplainer = failureExplainer;
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

  /** Dependencies for the shared fix-validation loop, with the validator subset picked once per operation. */
  private fixLoopDeps(label: string): IFixLoopDeps {
    return {
      primaryModel: this.reviewModels[0] ?? null,
      validator: this.pickActiveValidator(),
      toModelUsage: (rm, usage) => this.toModelUsage(rm, usage),
      label,
    };
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

  /** Runs one review as a trace of its own and counts it with its outcome and duration. */
  public async reviewPr(...args: Parameters<ReviewerService['runReviewPr']>): Promise<void> {
    const [project, slug, prId] = args;
    const startTime = performance.now();
    let outcome: ReviewOutcome = 'failed';
    try {
      outcome = await runInRootSpan(
        'PR review',
        { [ATTR_VCS_REPOSITORY_NAME]: `${project}/${slug}`, [ATTR_VCS_CHANGE_ID]: prId },
        () => this.runReviewPr(...args),
      );
    } finally {
      metricMeters.reviews.add(1, { outcome });
      metricMeters.reviewDuration.record((performance.now() - startTime) / 1000, { outcome });
    }
  }

  private async runReviewPr(
    project: string,
    slug: string,
    prId: number,
    targetBranch: string,
    sourceBranch: string,
    dockerImage?: string,
    rulesFiles?: string[],
    generateFixPrompts?: boolean,
    sourceCommit?: string,
    skipIfReviewed = false,
    /**
     * True when the caller (the poller's auto-review retry loop) has no
     * retries left after this attempt. On a throw, the failure comment gets
     * an LLM-written plain-language explanation (via `failureExplainer`) plus
     * a "won't retry automatically" note, instead of just the raw error.
     */
    isFinalAutoReviewAttempt = false,
  ): Promise<ReviewOutcome> {
    LogSink.info(`Reviewing PR #${prId} in ${project}/${slug}`, TraceTags.REVIEWER);

    // Fetch existing PR comments once: the reviewers see them (so they react to
    // what's already been said instead of re-raising fixed issues), and
    // postFindings reuses them for validator context and fix prompts.
    const existingComments = await this.provider.getComments(project, slug, prId);

    // Remote-side backstop for the local `lastReviewedCommit` gate: if a prior
    // run already posted a review for this exact commit, a missing/stale local
    // state file (e.g. daemon killed mid-cycle before `state.json` flushed)
    // must not cause a duplicate review. Only auto-review passes
    // skipIfReviewed; an explicit @mention re-review is always honored.
    if (skipIfReviewed && sourceCommit && hasBotReviewForCommit(existingComments, this.botUsername, sourceCommit)) {
      LogSink.info(
        `PR #${prId}: bot review for commit ${sourceCommit.slice(0, 7)} already present, skipping (local state was missing/stale)`,
        TraceTags.REVIEWER,
      );
      return 'skipped';
    }

    const reviewCommentContext = formatExistingCommentsForReview(existingComments);

    // PR intent context: title + description from the provider, plus the
    // originating Jira ticket when Jira is configured and a key is referenced
    // in the branch, title, or description. Every step degrades to null — a
    // missing PR fetch or Jira outage costs only the intent section.
    const pr = await this.provider.getPullRequest(project, slug, prId).catch((err) => {
      // Degrades to a review without PR intent — say so rather than losing the
      // context silently.
      LogSink.warn(
        `PR #${prId}: fetching PR metadata failed, reviewing without intent context: ${err}`,
        TraceTags.REVIEWER,
      );
      return null;
    });
    let ticket: ITicketInfo | null = null;
    if (this.jira.isEnabled) {
      const ticketKey = extractTicketKey([sourceBranch, pr?.title, pr?.description], this.jira.projectKeys);
      if (ticketKey) {
        ticket = await this.jira.getTicket(ticketKey);
        LogSink.info(
          `PR #${prId}: Jira ticket ${ticketKey} ${ticket ? 'loaded' : 'unavailable (see warning above)'}`,
          TraceTags.JIRA,
        );
      }
    }
    const prInfo = buildPrInfoBlob(pr ? { id: prId, title: pr.title, description: pr.description } : null, ticket);

    let result: Awaited<ReturnType<typeof this.runReview>>;
    try {
      result = await this.runReview(
        project,
        slug,
        prId,
        targetBranch,
        sourceBranch,
        reviewCommentContext,
        prInfo,
        dockerImage,
        rulesFiles,
      );
    } catch (err) {
      LogSink.error(`PR #${prId}: review failed: ${err}`, TraceTags.REVIEWER);
      const message = await this.buildFailureMessage(String(err), isFinalAutoReviewAttempt);
      await this.postOrUpdateFailureComment(project, slug, prId, message);
      throw err;
    }
    if (!result) return 'skipped';

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

    const { validationUsage, validatedFindings, allComments, discardedRound1, discardedRound2, skippedLargeFiles } =
      await this.postFindings(
        project,
        slug,
        prId,
        allFindings,
        chunks,
        fullDiff,
        sourceBranch,
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
        sourceCommit,
      );
    } catch (err) {
      LogSink.warn(`PR #${prId}: failed to post review summary, continuing: ${err}`, TraceTags.REVIEWER);
    }
    return 'reviewed';
  }

  private async runReview(
    project: string,
    slug: string,
    prId: number,
    targetBranch: string,
    sourceBranch: string,
    reviewCommentContext: string,
    prInfo: string | null,
    dockerImage?: string,
    rulesFiles?: string[],
  ): Promise<{
    allFindings: IAuthoredFinding[];
    reviewUsage: IModelUsage[];
    chunks: ReturnType<typeof splitDiffByFile>;
    fullDiff: string;
  } | null> {
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

    // Decide which runs will happen BEFORE paying for exploration: a repo with
    // only guideline-dependent roles (vegetable-police) and no guideline files
    // reviews nothing, and exploration for a review that never runs is pure cost.
    const { active: runs, skipped: skippedRuns } = filterRunsByStandards(
      expandReviewerRuns(this.reviewModels),
      standards !== null,
    );
    if (skippedRuns.length > 0) {
      LogSink.info(
        `PR #${prId}: skipping ${skippedRuns.length} run(s) (${skippedRuns
          .map((r) => `${r.model.name}/${r.role}`)
          .join(', ')}) — no guideline files (CLAUDE.md / AGENTS.md / rulesFiles) in repo`,
        TraceTags.REVIEWER,
      );
    }
    if (runs.length === 0) {
      LogSink.info(`PR #${prId}: no applicable review run(s), skipping review`, TraceTags.REVIEWER);
      return null;
    }
    LogSink.info(
      `PR #${prId}: ${runs.length} review run(s) across ${this.reviewModels.length} model(s): ` +
        `${runs.map((r) => `${r.model.name}/${r.role}`).join(', ')}`,
      TraceTags.REVIEWER,
    );

    // Exploration pass: walk the repo from the diff ONCE and share the gathered
    // context with every reviewer run below. The PR-intent blob steers what to
    // explore. explore() never throws — a broken exploration degrades to a
    // diff-only review.
    let repoContext: string | null = null;
    let explorationUsage: IModelUsage[] = [];
    if (this.contextExplorer.isEnabled) {
      const exploration = await this.contextExplorer.explore(
        diffToReview,
        this.buildInfoTool(project, slug, sourceBranch),
        prInfo,
      );
      repoContext = exploration.context || null;
      explorationUsage = exploration.usage;
      LogSink.info(
        `PR #${prId}: context exploration gathered ${repoContext ? `${repoContext.length} chars` : 'nothing'}`,
        TraceTags.REVIEWER,
      );
    }

    // Security scan pass: Semgrep (SAST) + gitleaks (secrets), scoped to only
    // this PR's changes, shared with every security-relevant persona run
    // below. Only worth paying for when at least one such run will happen.
    let scannerFindings = '';
    if (this.securityScanner.isEnabled && runs.some((r) => SCANNER_ELIGIBLE_PERSONAS.has(r.role))) {
      // Semgrep scans the working tree, not git objects — reset to this PR's
      // source tip first (gitleaks reads history directly and doesn't need
      // this, but resetting once for both is simpler and harmless).
      try {
        this.git.resetToRemoteBranch(project, slug, sourceBranch);
      } catch (err) {
        LogSink.warn(
          `PR #${prId}: could not reset to ${sourceBranch} before security scan: ${err}`,
          TraceTags.REVIEWER,
        );
      }
      const outcome = await this.securityScanner.scan(this.git.getRepoDir(project, slug), targetBranch, sourceBranch);
      scannerFindings = outcome.findings;
      // Per-tool status, not just found/not-found: both tools degrade silently
      // on failure, so a crash must not read as a clean scan.
      LogSink.info(`PR #${prId}: security scan — ${outcome.status || 'disabled'}`, TraceTags.REVIEWER);
    }

    const allFindings: IAuthoredFinding[] = [];
    const reviewUsage: IModelUsage[] = [];
    for (const { model: rm, role } of runs) {
      // Each run blocks the event loop for minutes — tick before every one.
      this.heartbeat();
      try {
        const batch = rm.pi.reviewBatch(reviewable, {
          codeStandards: standards,
          existingComments: reviewCommentContext,
          repoContext,
          prInfo,
          dockerImageOverride: dockerImage,
          personaDirective: PERSONA_DIRECTIVES[role],
          scannerFindings: scannerFindingsForRole(role, scannerFindings),
        });
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
    // still records usage, so an empty reviewUsage means nothing produced output.
    // Exploration usage is merged only after this check so it can't mask that.)
    if (reviewUsage.length === 0) {
      // Exploration already cost money even though no summary will report it.
      if (explorationUsage.length > 0) {
        const spent = explorationUsage.reduce((sum, u) => sum + u.costEur, 0);
        const tokens = explorationUsage.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
        LogSink.warn(
          `PR #${prId}: exploration spent ${tokens} token(s) (${spent.toFixed(4)} EUR) before every review run failed`,
          TraceTags.REVIEWER,
        );
      }
      throw new Error(`all ${runs.length} review run(s) failed`);
    }
    reviewUsage.unshift(...explorationUsage);

    if (allFindings.length === 0) {
      LogSink.info(`PR #${prId}: no issues found across ${runs.length} review run(s)`, TraceTags.REVIEWER);
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
        // the repo checked out at the source branch's tip.
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

      const piVerify: IPiVerifier = async (findingsArg, splitIndices) => {
        const primaryModel = this.reviewModels[0];
        if (!primaryModel) return { results: new Map(), usage: [], modelName: null };
        try {
          // The verification container blocks the event loop for its whole
          // run (like every other pi call) and can now run long enough to
          // risk the container health check going stale without a tick.
          this.heartbeat();
          // pi reads the working tree directly, so it must be checked out at
          // the PR's source branch tip — same requirement as the
          // info-gatherer's git-grep tool above. A failed reset must not
          // proceed to verify against a stale tree, so it falls through to
          // the catch below (no evidence) rather than being swallowed here.
          this.git.resetToRemoteBranch(project, slug, sourceBranch);
          const repoDir = this.git.getRepoDir(project, slug);
          const inputs = buildPiVerificationInputs(findingsArg, splitIndices);
          const verification = primaryModel.pi.verifyFindings(inputs, repoDir, dockerImage);
          return {
            results: mapVerificationResultsBack(verification.results, splitIndices),
            usage: [this.toModelUsage(primaryModel, verification.usage)],
            modelName: primaryModel.name,
          };
        } catch (err) {
          LogSink.warn(
            `PR #${prId}: pi verification failed, judging on round-1 votes alone: ${err}`,
            TraceTags.REVIEWER,
          );
          return { results: new Map(), usage: [], modelName: null };
        }
      };

      try {
        const validation = await activeValidator.validateFindings(
          dedupedFindings,
          fullDiff,
          fileContentByPath,
          humanComments,
          additionalContextByFile,
          followUpGather,
          piVerify,
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

    // 6b. Propose typo/description-only suggestions for kept findings, then
    //     gate them with a validator. This runs on the chat-completions council
    //     (no pi runner, no container): proposals are derived from the diff and
    //     the file content already held in memory, so no repo checkout is needed.
    let approvedSuggestions = new Map<number, IFixProposal>();
    if (validatedFindings.length > 0 && activeValidator.hasModels) {
      try {
        const carrotConfig = await this.carrotConfigService.getConfig(project, slug);
        const suggestEnabled = carrotConfig?.suggestCodeFixes !== false;
        if (suggestEnabled) {
          const { proposals, usage: proposeUsage } = await activeValidator.proposeTextFixes(
            validatedFindings,
            fullDiff,
          );
          validationUsage.push(...proposeUsage);

          // Keep only replace-proposals whose range is entirely ADDED lines, and
          // attach the surrounding file content (already fetched into
          // fileContentByPath) as validation context.
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
            const fileContent = fileContentByPath.get(finding.filePath);
            if (!fileContent) continue;
            const fileLines = fileContent.split('\n');
            const sliceStart = Math.max(0, p.startLine - 1 - 300);
            const sliceEnd = Math.min(fileLines.length, p.endLine + 300);
            fileContextMap.set(p.findingIndex, fileLines.slice(sliceStart, sliceEnd).join('\n'));
          }

          // validateSuggestions internally filters replaceProposals to those with
          // entries in fileContextMap (i.e., proposals that survived isAddedRange).
          if (fileContextMap.size > 0) {
            // Gate with a single validator, preferring one that did not author the
            // proposal so the check is a genuinely independent second pass.
            const proposerName = activeValidator.modelNames[0];
            const suggestionValidator = activeValidator.withRandomSubset(1, proposerName ? [proposerName] : []);
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

          LogSink.debug(
            `PR #${prId}: proposeTextFixes returned ${replaceProposals.length} replace proposal(s) for ${validatedFindings.length} finding(s)`,
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

      input.text = `${severityPrefix}: ${finding.comment}${attributionSuffix(finding)}${notesSuffix}${suggestionSuffix}`;
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
    sourceCommit?: string,
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
        ? `\n\n*Validators discarded ${totalDiscarded} finding(s) (${discardedRound1} round 1, ${discardedRound2} deliberation)*`
        : '';

    const usage = [...reviewUsage, ...validatorUsage];
    recordModelUsage(usage);
    const footer = formatTokenFooter(usage);
    // Hidden marker so a restarted daemon can detect this commit was already
    // reviewed even if its local state was lost (see reviewPr's skip guard).
    const marker = sourceCommit ? `\n\n${reviewCommitMarker(sourceCommit)}` : '';
    const commentBody = `${header}\n\n${breakdown}${skippedLine}${fixPromptsSection}${discardLine}\n\n${footer}${marker}`;
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

    const { earlyReturn, usage: loopUsage } = await runFixValidationLoop(
      this.fixLoopDeps(`PR #${prId}`),
      userMessage,
      diff,
      repoDir,
      dockerImage,
      generateFixPrompts,
    );
    fixUsage.push(...loopUsage);
    recordModelUsage(fixUsage);
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

    const loopDeps = this.fixLoopDeps(`PR #${prId}`);
    const lintResult = runLintAndFixErrors(loopDeps, repoDir, diff, fixUsage, dockerImage);

    const { earlyReturn, usage: loopUsage } = await runFixValidationLoop(
      loopDeps,
      fixMessage,
      diff,
      repoDir,
      dockerImage,
      generateFixPrompts,
    );
    fixUsage.push(...loopUsage);
    recordModelUsage(fixUsage);
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

  /**
   * Every attempt gets the raw (truncated) error, cheap and immediate. The
   * final auto-review attempt additionally gets an LLM-written plain-language
   * explanation (when a failure-explainer model is configured) plus a note
   * that the bot has given up and won't retry — so a reader doesn't have to
   * guess whether another attempt is still coming.
   */
  private async buildFailureMessage(rawError: string, isFinalAutoReviewAttempt: boolean): Promise<string> {
    if (!isFinalAutoReviewAttempt || !this.failureExplainer.isEnabled) {
      return `Automated review failed: ${rawError.slice(0, 200)}`;
    }

    const { text, usage } = await this.failureExplainer.explain(rawError);
    if (usage.length > 0) {
      LogSink.debug(`Failure explainer usage: ${JSON.stringify(usage)}`, TraceTags.REVIEWER);
    }
    return [
      `Automated review failed and will not retry automatically.`,
      '',
      text,
      '',
      `Raw error: ${rawError.slice(0, 200)}`,
      '',
      `Mention @${this.botUsername} on this PR to try again.`,
    ].join('\n');
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
