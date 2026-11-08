import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IGitProvider } from '../provider/provider';
import type { GitService } from '../reviewer/git.service';
import type { JiraService, IJiraIssueForRun } from '../jira/jira.service';
import { isSameJiraUser, type IJiraUser } from '../jira/jira-identity';
import type { StateService } from '../poller/state.service';
import type { CarrotConfigService } from '../config/carrot-config.service';
import { formatTokenFooter, type IReviewModel } from '../reviewer/reviewer.service';
import type { MultiModelValidator } from '../reviewer/multi-model-validator';
import type { FailureExplainer } from '../reviewer/failure-explainer';
import type { ITicketState, IModelUsage } from '../types';
import { CARROT_CONFIG_DEFAULTS } from '../config/carrot-config.types';
import { runFixValidationLoop, runLintAndFixErrors, type IFixLoopDeps } from '../reviewer/fix-loop';
import type { IPiTokenUsage } from '../reviewer/pi.service';
import { buildRepoMap, projectKeyOf, RepoPicker, type ITicketRepo, type TicketRepoMap } from './ticket-repo-map';
import { decideTicketMode, findNewMention, newestCommentId, type TicketMode } from './ticket-mode';
import { findExistingTicketBranch, ticketBranchName } from './ticket-branch';
import { buildTicketMarkdown, ticketRequestText } from './ticket-prompt';
import { recordModelUsage } from '../instrumentation/metrics';
import { runInRootSpan } from '../instrumentation/tracing';

/** Failed runs before carrot gives up on an assignment and hands the ticket back. */
export const MAX_TICKET_ATTEMPTS = 3;
/** Cap per JQL query per cycle. */
export const MAX_TICKETS_PER_QUERY = 50;

export const ASSIGNED_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated ASC';
/**
 * Coarse filter for mentions on tickets not assigned to the bot. JQL has no
 * mention operator, so `comment ~ "carrot"` narrows and the identity check
 * decides. Two days bounds the cost.
 */
export const MENTIONED_ELSEWHERE_JQL =
  '(assignee is EMPTY OR assignee != currentUser()) AND comment ~ "carrot" AND updated >= -2d ORDER BY updated ASC';

export const NOT_ASSIGNED_REPLY =
  'I only work on tickets that are assigned to me. Assign this ticket to me to start, or to continue on the existing branch after a mention.';

/** The Jira comment posted after a successful run. Order: outcome, branch, PR, summary, cost footer. */
export function buildResultComment(input: {
  branch: string;
  prUrlOrId: string;
  summary: string | null;
  footer: string;
}): string {
  return [
    'Implemented on branch:',
    input.branch,
    '',
    `Pull request: ${input.prUrlOrId}`,
    '',
    input.summary ?? 'Changes applied.',
    '',
    input.footer,
  ].join('\n');
}

export interface ITicketServiceDeps {
  provider: IGitProvider;
  git: GitService;
  jira: JiraService;
  state: StateService;
  carrotConfig: CarrotConfigService;
  /** Review-enabled model that runs pi implement. null disables the phase. */
  implementModel: IReviewModel | null;
  multiValidator: MultiModelValidator;
  maxValidators: number;
  repoPicker: RepoPicker;
  failureExplainer: FailureExplainer;
  /** Liveness tick; pi runs block the event loop for minutes. */
  heartbeat: () => void;
}

/**
 * Flow 4: Jira tickets assigned to the bot get implemented by pi on a fixed
 * `feature/KEY-slug` branch, delivered as a PR, reported on the ticket, and
 * assigned back. Runs as the first phase of every poll cycle so the PR phase
 * of the same cycle reviews the new PR.
 *
 * Carrot works only on tickets assigned to it. Removing the assignment is the
 * safe stop; a mention elsewhere gets one reply and no work.
 */
export class TicketService {
  private bot: IJiraUser | null = null;

  constructor(private readonly deps: ITicketServiceDeps) {}

  public async init(): Promise<boolean> {
    if (!this.deps.jira.isEnabled) {
      LogSink.debug('Tickets: Jira disabled — ticket flow off', TraceTags.JIRA);
      return false;
    }
    if (!this.deps.implementModel) {
      LogSink.warn('Tickets: no review-enabled model for IMPLEMENT_MODEL_SLOT — ticket flow off', TraceTags.JIRA);
      return false;
    }
    this.bot = await this.deps.jira.getMyself();
    if (!this.bot) {
      LogSink.warn('Tickets: GET /myself failed — ticket flow off until the next restart', TraceTags.JIRA);
      return false;
    }
    LogSink.info(
      `Tickets: enabled as ${this.bot.displayName} (model: ${this.deps.implementModel.name})`,
      TraceTags.JIRA,
    );
    return true;
  }

  public async pollTickets(): Promise<void> {
    if (!this.bot || !this.deps.implementModel) return;
    try {
      const assigned = await this.deps.jira.searchIssues(ASSIGNED_JQL, MAX_TICKETS_PER_QUERY);
      const mentionedElsewhere = await this.deps.jira.searchIssues(MENTIONED_ELSEWHERE_JQL, MAX_TICKETS_PER_QUERY);
      if (assigned.length === 0 && mentionedElsewhere.length === 0) return;
      LogSink.info(
        `Tickets: ${assigned.length} assigned, ${mentionedElsewhere.length} mentioned elsewhere`,
        TraceTags.JIRA,
      );

      const repoMap = await this.buildRepoMap();
      const unmapped: string[] = [];

      for (const key of mentionedElsewhere) {
        const repos = repoMap.get(projectKeyOf(key));
        if (!repos || repos.length === 0) {
          unmapped.push(key);
          continue;
        }
        try {
          await this.handleMentionedElsewhere(key);
        } catch (err) {
          LogSink.error(`Tickets: ${key} (not assigned) failed: ${err}`, TraceTags.JIRA);
        }
      }

      for (const key of assigned) {
        const repos = repoMap.get(projectKeyOf(key));
        if (!repos || repos.length === 0) {
          unmapped.push(key);
          continue;
        }
        try {
          await runInRootSpan('ticket', { 'jira.issue.key': key }, () => this.handleAssigned(key, repos));
        } catch (err) {
          LogSink.error(`Tickets: ${key} failed: ${err}`, TraceTags.JIRA);
        }
      }
      if (unmapped.length > 0) {
        LogSink.debug(
          `Tickets: no repo claims the project of ${unmapped.join(', ')} (another instance may own it)`,
          TraceTags.JIRA,
        );
      }
    } catch (err) {
      LogSink.error(`Tickets: poll failed: ${err}`, TraceTags.JIRA);
    } finally {
      this.deps.state.save();
    }
  }

  /** `.carrot.jsonc` of every repo → project key map. Config is cached per cycle, so the PR phase reuses these fetches. */
  private async buildRepoMap(): Promise<TicketRepoMap> {
    const entries: Array<{
      project: string;
      slug: string;
      config: Awaited<ReturnType<CarrotConfigService['getConfig']>>;
    }> = [];
    const projects = await this.deps.provider.listProjects();
    for (const project of projects) {
      const repos = await this.deps.provider.listRepos(project.key);
      for (const repo of repos) {
        let config: Awaited<ReturnType<CarrotConfigService['getConfig']>> = null;
        try {
          config = await this.deps.carrotConfig.getConfig(project.key, repo.slug, { recordCycleGaps: false });
        } catch (err) {
          LogSink.warn(`Tickets: could not read .carrot.jsonc of ${project.key}/${repo.slug}: ${err}`, TraceTags.JIRA);
        }
        entries.push({ project: project.key, slug: repo.slug, config });
      }
    }
    return buildRepoMap(entries);
  }

  /** Spec 1a: one reply, no work. */
  private async handleMentionedElsewhere(key: string): Promise<void> {
    const bot = this.bot!;
    const issue = await this.deps.jira.getIssueForRun(key, bot);
    if (!issue) return;
    const state = this.deps.state.getTicketState(key);
    const mention = findNewMention(issue.comments, state?.lastCommentId ?? 0, bot);
    if (!mention) return;

    LogSink.info(`Tickets: ${key} mentions the bot but is not assigned to it — replying only`, TraceTags.JIRA);
    await this.deps.jira.addComment(key, NOT_ASSIGNED_REPLY);
    this.deps.state.setTicketState(key, {
      repoKey: state?.repoKey ?? '',
      branch: state?.branch,
      prId: state?.prId,
      attempts: state?.attempts ?? 0,
      lastCommentId: newestCommentId(issue.comments),
      lastRunAt: new Date().toISOString(),
      lastError: state?.lastError,
    });
  }

  private async handleAssigned(key: string, candidates: ITicketRepo[]): Promise<void> {
    const bot = this.bot!;
    const issue = await this.deps.jira.getIssueForRun(key, bot);
    if (!issue) return;
    const state = this.deps.state.getTicketState(key);
    const mode = decideTicketMode({ issue, state, bot });
    if (mode.kind === 'skip') {
      LogSink.debug(`Tickets: ${key} skipped — ${mode.reason}`, TraceTags.JIRA);
      return;
    }
    await this.runTicket(issue, candidates, mode, state);
  }

  private async runTicket(
    issue: IJiraIssueForRun,
    candidates: ITicketRepo[],
    mode: TicketMode,
    state: ITicketState | undefined,
  ): Promise<void> {
    const { key } = issue;
    const bot = this.bot!;
    const usage: IModelUsage[] = [];
    const watermark = newestCommentId(issue.comments);
    // Set once the branch is pushed; carries the PR id once the PR step also
    // succeeds. If a later step in this try (PR, comment, hand-back) then
    // throws, the catch must not treat the already-pushed work as a plain
    // failed attempt — it keeps the branch (and, once set, the PR) on record.
    let delivered: { branch: string; prId?: number } | null = null;
    // Hoisted out of the try so the catch can report what was picked even
    // when the throw happened before or while these were being determined.
    let repo: ITicketRepo | undefined;
    let repoKey: string | undefined;
    let branch: string | undefined;

    try {
      // 1. Repo.
      const picked = await this.deps.repoPicker.pick(issue, candidates);
      usage.push(...picked.usage);
      if (!picked.repo) {
        const list = candidates.map((c) => `${c.project}/${c.slug}`).join(', ');
        await this.deps.jira.addComment(
          key,
          `I can not tell which repository this ticket belongs to. Candidates: ${list}. Move the project key to one repo's .carrot.jsonc, or name the repository in the ticket, then assign it to me again.`,
        );
        await this.handBack(issue, null);
        this.writeState(key, { ...this.baseState(state, candidates[0]), lastCommentId: watermark });
        return;
      }
      repo = picked.repo;
      repoKey = `${repo.project}/${repo.slug}`;

      // 2. Branch.
      const branches = await this.deps.provider.listBranches(repo.project, repo.slug);
      const existing = findExistingTicketBranch(key, branches);
      if (mode.kind === 'fresh' && existing) {
        LogSink.info(`Tickets: ${key} — branch ${existing} exists; handing back`, TraceTags.JIRA);
        await this.deps.jira.addComment(
          key,
          `Branch ${existing} already exists. Mention @carrot on this ticket to continue on it.`,
        );
        await this.handBack(issue, null);
        this.writeState(key, { ...this.baseState(state, repo), branch: existing, lastCommentId: watermark });
        return;
      }
      branch = existing ?? ticketBranchName(key, issue.summary);

      // 3. Prepare.
      this.deps.git.cloneOrFetch(repo.project, repo.slug);
      const defaultBranch = await this.resolveDefaultBranch(repo);
      this.deps.git.resetToRemoteBranch(repo.project, repo.slug, existing ?? defaultBranch);
      const repoDir = this.deps.git.getRepoDir(repo.project, repo.slug);

      // 4. Prompt.
      const rules = await this.readRules(repo, defaultBranch);
      const markdown = buildTicketMarkdown({
        key,
        summary: issue.summary,
        description: issue.description,
        comments: issue.comments,
        instruction:
          mode.kind === 'continue'
            ? { author: mode.mention.author.displayName || 'unknown', text: mode.mention.text }
            : undefined,
        rules,
      });

      // 5. Run.
      const model = this.deps.implementModel!;
      const dockerImage = repo.config.dockerImage;
      this.deps.heartbeat();
      LogSink.info(`Tickets: ${key} — running pi implement in ${repoKey} (${mode.kind})`, TraceTags.JIRA);
      const result = model.pi.implement(repoDir, markdown, dockerImage);
      usage.push(this.toModelUsage(model, result.usage));
      let summary = result.summary;

      const loopDeps: IFixLoopDeps = {
        primaryModel: model,
        validator: this.deps.multiValidator.withRandomSubset(this.deps.maxValidators),
        toModelUsage: (rm, u) => this.toModelUsage(rm, u),
        label: key,
      };
      this.deps.heartbeat();
      runLintAndFixErrors(loopDeps, repoDir, '', usage, dockerImage);

      // 5a. Nothing changed → failed run, nothing to push.
      const status = this.deps.git.execGit(['status', '--porcelain'], { cwd: repoDir, stdio: 'pipe' }).trim();
      if (!status) {
        await this.recordFailure(issue, repo, state, watermark, 'No changes were needed.', usage);
        return;
      }

      this.deps.heartbeat();
      const validation = await runFixValidationLoop(
        loopDeps,
        ticketRequestText(issue),
        '',
        repoDir,
        dockerImage,
        repo.config.generateFixPrompts,
      );
      usage.push(...validation.usage);
      if (validation.earlyReturn) {
        await this.recordFailure(issue, repo, state, watermark, validation.earlyReturn, usage);
        return;
      }

      // 6. Safe stop.
      const fresh = await this.deps.jira.getIssueForRun(key, bot);
      if (!fresh) {
        // Fail closed: can not confirm the assignee still holds, so do not push.
        await this.recordFailure(
          issue,
          repo,
          state,
          watermark,
          'Could not re-check the ticket assignee before pushing; nothing was pushed.',
          usage,
        );
        return;
      }
      if (!isSameJiraUser(fresh.assignee, bot)) {
        LogSink.info(`Tickets: ${key} was unassigned during the run — discarding changes`, TraceTags.JIRA);
        this.discardWorkingTree(repoDir);
        await this.deps.jira.addComment(
          key,
          'Stopped: the ticket was unassigned from me during the run. Nothing was pushed.',
        );
        this.writeState(key, {
          ...this.baseState(state, repo),
          branch: existing ?? state?.branch,
          lastCommentId: watermark,
        });
        return;
      }

      // 7. Deliver.
      const commitMsg = `feat(${key}): ${issue.summary.slice(0, 60)}`;
      if (existing) {
        this.deps.git.commitAndPush(repo.project, repo.slug, commitMsg);
      } else {
        try {
          // A previous push may have committed locally then failed to reach
          // the remote, leaving a stale local branch that blocks `checkout -b`.
          this.deps.git.execGit(['branch', '-D', branch], { cwd: repoDir, stdio: 'pipe' });
        } catch {
          // no stale local branch
        }
        this.deps.git.createBranchCommitAndPush(repo.project, repo.slug, branch, commitMsg);
      }
      // The push is real now — a throw from the PR step below must not lose
      // track of the branch that is already on the remote.
      delivered = { branch };

      summary = summary ?? 'Changes applied.';
      const openPrs = await this.deps.provider.getOpenPullRequests(repo.project, repo.slug);
      const openPr = openPrs.find((pr) => pr.sourceBranch === branch);
      let prId: number;
      if (openPr) {
        prId = openPr.id;
        await this.deps.provider.postGeneralComment(repo.project, repo.slug, prId, summary);
      } else {
        prId = await this.deps.provider.createFixPr(
          repo.project,
          repo.slug,
          `${key}: ${issue.summary}`,
          `${summary}\n\nTicket: ${this.deps.jira.issueUrl(key)}`,
          branch,
          defaultBranch,
        );
      }
      delivered.prId = prId;

      // The push and PR are real now — record them before any Jira write can
      // throw and lose track of what was already delivered.
      this.writeState(key, {
        repoKey,
        branch,
        prId,
        attempts: 0,
        lastCommentId: watermark,
        lastRunAt: new Date().toISOString(),
      });

      // 8. Hand-back.
      recordModelUsage(usage);
      const footer = formatTokenFooter(usage);
      await this.deps.jira.addComment(key, buildResultComment({ branch, prUrlOrId: `PR #${prId}`, summary, footer }));
      await this.handBack(issue, repo.config.jiraDoneTransition);

      LogSink.info(`Tickets: ${key} — delivered PR #${prId} on ${branch}`, TraceTags.JIRA);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (delivered?.prId !== undefined) {
        LogSink.error(
          `Tickets: ${key} delivered PR #${delivered.prId} on ${delivered.branch} but the hand-back failed: ${message}`,
          TraceTags.JIRA,
        );
        this.writeState(key, {
          repoKey: repoKey!,
          branch: delivered.branch,
          prId: delivered.prId,
          attempts: 0,
          lastCommentId: watermark,
          lastRunAt: new Date().toISOString(),
          lastError: this.deps.git.redactPat(message),
        });
        return;
      }
      const repoForFailure = repo ?? candidates[0];
      if (delivered) {
        // Push succeeded but the PR step itself threw: the attempt counts as
        // a failure, but the pushed branch stays on record so it is not lost.
        await this.recordFailure(
          issue,
          repoForFailure,
          { ...this.baseState(state, repoForFailure), branch: delivered.branch },
          watermark,
          message,
          usage,
        );
        return;
      }
      await this.recordFailure(issue, repoForFailure, state, watermark, message, usage);
    }
  }

  private async resolveDefaultBranch(repo: ITicketRepo): Promise<string> {
    const branch = await this.deps.provider.getDefaultBranch(repo.project, repo.slug);
    if (branch) return branch;
    LogSink.warn(
      `Tickets: ${repo.project}/${repo.slug} has no default branch reported — assuming "main"`,
      TraceTags.JIRA,
    );
    return 'main';
  }

  private async readRules(
    repo: ITicketRepo,
    defaultBranch: string,
  ): Promise<Array<{ fileName: string; content: string }>> {
    const names = repo.config.rulesFiles ?? CARROT_CONFIG_DEFAULTS.rulesFiles ?? [];
    const rules: Array<{ fileName: string; content: string }> = [];
    for (const fileName of names) {
      const content = await this.deps.provider.getFileContent(repo.project, repo.slug, fileName, {
        at: defaultBranch,
        quiet: true,
      });
      if (content) rules.push({ fileName, content });
    }
    return rules;
  }

  private discardWorkingTree(repoDir: string): void {
    try {
      this.deps.git.execGit(['checkout', '--', '.'], { cwd: repoDir, stdio: 'pipe' });
      this.deps.git.execGit(['clean', '-fd'], { cwd: repoDir, stdio: 'pipe' });
    } catch (err) {
      LogSink.warn(`Tickets: could not reset ${repoDir}: ${err}`, TraceTags.JIRA);
    }
  }

  /** Comment is already posted by the caller. Reassign to the assigner (fallback: reporter), then the optional transition. */
  private async handBack(issue: IJiraIssueForRun, transitionName: string | null | undefined): Promise<void> {
    const target = issue.assignment?.assignedBy ?? issue.reporter;
    if (!target) {
      LogSink.warn(`Tickets: ${issue.key} has no assigner and no reporter — unassigning`, TraceTags.JIRA);
    }
    const reassigned = await this.deps.jira.assign(issue.key, target);
    if (!reassigned) {
      LogSink.error(`Tickets: ${issue.key} could not be reassigned — it stays assigned to the bot`, TraceTags.JIRA);
    }

    if (!transitionName) return;
    const transitions = await this.deps.jira.getTransitions(issue.key);
    const match = transitions.find((t) => t.name.toLowerCase() === transitionName.toLowerCase());
    if (!match) {
      LogSink.warn(
        `Tickets: ${issue.key} has no transition named "${transitionName}" (available: ${transitions.map((t) => t.name).join(', ') || 'none'})`,
        TraceTags.JIRA,
      );
      return;
    }
    await this.deps.jira.transition(issue.key, match.id);
  }

  /** attempts+1; on the cap, comment the error, hand back, reset attempts. Always resets the tree. */
  private async recordFailure(
    issue: IJiraIssueForRun,
    repo: ITicketRepo,
    state: ITicketState | undefined,
    watermark: number,
    error: string,
    usage: IModelUsage[],
  ): Promise<void> {
    const { key } = issue;
    const redactedError = this.deps.git.redactPat(error);
    this.discardWorkingTree(this.deps.git.getRepoDir(repo.project, repo.slug));
    const attempts = (state?.attempts ?? 0) + 1;
    LogSink.warn(
      `Tickets: ${key} failed (attempt ${attempts}/${MAX_TICKET_ATTEMPTS}): ${redactedError.slice(0, 300)}`,
      TraceTags.JIRA,
    );

    if (attempts < MAX_TICKET_ATTEMPTS) {
      this.writeState(key, {
        ...this.baseState(state, repo),
        attempts,
        lastCommentId: watermark,
        lastError: redactedError,
      });
      return;
    }

    let explanation = '';
    if (this.deps.failureExplainer.isEnabled) {
      const explained = await this.deps.failureExplainer.explain(redactedError);
      usage.push(...explained.usage);
      explanation = `${explained.text}\n\n`;
    }
    recordModelUsage(usage);
    await this.deps.jira.addComment(
      key,
      [
        `I could not implement this ticket after ${MAX_TICKET_ATTEMPTS} attempts.`,
        '',
        `${explanation}Last error: ${redactedError.slice(0, 1500)}`,
        '',
        formatTokenFooter(usage),
      ].join('\n'),
    );
    await this.handBack(issue, null);
    this.writeState(key, {
      ...this.baseState(state, repo),
      attempts: 0,
      lastCommentId: watermark,
      lastError: redactedError,
    });
  }

  private baseState(state: ITicketState | undefined, repo: ITicketRepo): ITicketState {
    return {
      repoKey: `${repo.project}/${repo.slug}`,
      branch: state?.branch,
      prId: state?.prId,
      attempts: state?.attempts ?? 0,
      lastCommentId: state?.lastCommentId ?? 0,
      lastRunAt: new Date().toISOString(),
      lastError: state?.lastError,
    };
  }

  private writeState(key: string, next: ITicketState): void {
    this.deps.state.setTicketState(key, { ...next, lastRunAt: new Date().toISOString() });
    this.deps.state.save();
  }

  private toModelUsage(rm: IReviewModel, usage: IPiTokenUsage): IModelUsage {
    return {
      modelName: rm.name,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costEur:
        (usage.inputTokens / 1_000_000) * rm.inputCostPer1M + (usage.outputTokens / 1_000_000) * rm.outputCostPer1M,
    };
  }
}
