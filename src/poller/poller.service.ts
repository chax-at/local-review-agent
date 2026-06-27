import { execFileSync } from 'child_process';
import * as fs from 'fs';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IGitProvider } from '../provider/provider';
import { GitProviderAuthError } from '../provider/provider';
import type { IPullRequest } from '../provider/provider.types';
import { StateService } from './state.service';
import { ReviewerService } from '../reviewer/reviewer.service';
import { CarrotConfigService } from '../config/carrot-config.service';
import { GitService } from '../reviewer/git.service';
import type { IMentionCommand } from '../types';
import { REPO_ACTIVITY_WINDOW_MS, repoHasRecentActivity } from './repo-activity';
import { BOT_BRANCH_PREFIXES, BOT_TEMP_DIR, branchTimestamp, isBotComment, isBotMention } from '../constants';
import { MentionRouter } from './mention-router';
import { executeMentionTool } from './mention-executor';
import { buildMentionContext, sliceCodeAroundLine, type IMentionContext } from './mention-context';
import type { ICarrotConfig } from '../config/carrot-config.types';

/**
 * How many times a failing auto-review is retried (one attempt per poll cycle)
 * before giving up. Every retry costs a full review's LLM spend across all
 * active models, so an uncapped retry loop on a persistently broken PR would
 * burn money every cycle forever. After the cap, the PR's failure comment
 * (updated in-place each attempt) remains visible and an explicit `@mention`
 * review still works.
 */
export const MAX_AUTO_REVIEW_ATTEMPTS = 3;

export class PollerService {
  private readonly provider: IGitProvider;
  private readonly state: StateService;
  private readonly reviewer: ReviewerService;
  private readonly carrotConfig: CarrotConfigService;
  private readonly git: GitService;
  private readonly router: MentionRouter;
  private readonly botUsername: string;
  private readonly intervalMs: number;
  private readonly heartbeatPath: string;
  private shutdownRequested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    provider: IGitProvider,
    state: StateService,
    reviewer: ReviewerService,
    carrotConfig: CarrotConfigService,
    git: GitService,
    router: MentionRouter,
    botUsername: string,
    intervalMs: number,
    heartbeatPath: string,
  ) {
    this.provider = provider;
    this.state = state;
    this.reviewer = reviewer;
    this.carrotConfig = carrotConfig;
    this.git = git;
    this.router = router;
    this.botUsername = botUsername;
    this.intervalMs = intervalMs;
    this.heartbeatPath = heartbeatPath;
  }

  public async start(): Promise<void> {
    this.state.load();
    LogSink.info(`Poller started. Interval: ${this.intervalMs}ms`, TraceTags.POLLER);
    await this.runOneCycle();
    this.scheduleNext();
  }

  public shutdown(): void {
    this.shutdownRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    LogSink.info('Poller shutdown requested', TraceTags.POLLER);
  }

  private scheduleNext(): void {
    if (this.shutdownRequested) return;
    this.timer = setTimeout(() => {
      this.runOneCycle()
        .catch((err) => {
          LogSink.error(`Poll cycle threw unexpectedly: ${err}`, TraceTags.POLLER);
        })
        .finally(() => {
          this.scheduleNext();
        });
    }, this.intervalMs);
  }

  private async runOneCycle(): Promise<void> {
    await this.pollCycle();
  }

  private async pollCycle(): Promise<void> {
    LogSink.info('Starting poll cycle...', TraceTags.POLLER);
    this.writeHeartbeat();
    this.cleanupTempDir();
    this.carrotConfig.resetCycleCarrotGaps();
    this.carrotConfig.clearCache();
    this.git.resetFetchMemo();
    this.state.pruneStale(30);

    // ── Discover repos and poll PRs ──
    try {
      let dormantRepoCount = 0;
      let reposTouched = 0;
      const now = Date.now();
      const projects = await this.provider.listProjects();
      for (const project of projects) {
        if (this.shutdownRequested) break;
        const repos = await this.provider.listRepos(project.key);
        reposTouched += repos.length;
        for (const repo of repos) {
          try {
            const prs = await this.provider.getOpenPullRequests(project.key, repo.slug);
            const commitTs = await this.provider.getLatestCommitTimestampMs(project.key, repo.slug);
            if (!repoHasRecentActivity(commitTs, prs, REPO_ACTIVITY_WINDOW_MS, now)) {
              dormantRepoCount += 1;
              continue;
            }
            await this.pollRepo(project.key, repo.slug, prs);
          } catch (err) {
            if (err instanceof GitProviderAuthError) {
              LogSink.error(`Auth failed: ${err.message}. Halting.`, TraceTags.POLLER);
              process.exit(1);
            }
            LogSink.error(`Failed to poll ${project.key}/${repo.slug}: ${err}`, TraceTags.POLLER);
          }
        }
      }
      LogSink.debug(
        `Poll cycle: ${projects.length} project(s), ${reposTouched} repo(s) scanned${dormantRepoCount > 0 ? `, ${dormantRepoCount} dormant (skipped)` : ''}`,
        TraceTags.POLLER,
      );
      if (dormantRepoCount > 0) {
        LogSink.info(
          `Ignored ${dormantRepoCount} repo(s) with no default-branch or open-PR activity in the last 7 days`,
          TraceTags.POLLER,
        );
      }
    } catch (err) {
      if (err instanceof GitProviderAuthError) {
        LogSink.error(`Auth failed: ${err.message}. Halting.`, TraceTags.POLLER);
        process.exit(1);
      }
      LogSink.error(`Poll cycle failed: ${err}`, TraceTags.POLLER);
    }

    // ── Cycle summary ──
    const carrotGaps = this.carrotConfig.getCycleCarrotGaps();
    if (carrotGaps.missingFile.length > 0) {
      LogSink.debug(`No .chaxy.jsonc/.carrot.jsonc for: ${carrotGaps.missingFile.join(', ')}`, TraceTags.POLLER);
    }
    if (carrotGaps.invalidFile.length > 0) {
      LogSink.warn(`Invalid .chaxy.jsonc/.carrot.jsonc for: ${carrotGaps.invalidFile.join(', ')}`, TraceTags.POLLER);
    }

    this.state.save();
    LogSink.info('Poll cycle complete.', TraceTags.POLLER);
  }

  private async pollRepo(project: string, slug: string, prs: IPullRequest[]): Promise<void> {
    const repoKey = `${project}/${slug}`;

    if (prs.length === 0) return;

    // Only fetch the chaxy config if repo has open PRs
    const carrotConf = await this.carrotConfig.getConfig(project, slug);
    if (!carrotConf) {
      return;
    }

    LogSink.info(`Polling ${repoKey} (${prs.length} open PR(s))...`, TraceTags.POLLER);

    // Filter out drafts, bot-authored PRs, and bot-branched PRs.
    const eligiblePrs = prs.filter(
      (pr) =>
        !pr.draft &&
        pr.authorUsername !== this.botUsername &&
        !BOT_BRANCH_PREFIXES.some((p) => pr.sourceBranch.startsWith(p)),
    );

    const prStateParts: string[] = [];

    for (const pr of eligiblePrs) {
      if (this.shutdownRequested) break;

      try {
        const prState = this.state.getPrState(repoKey, String(pr.id));
        const latestCommit = pr.sourceCommit;
        const synced = prState?.lastReviewedCommit === latestCommit;
        prStateParts.push(`#${pr.id}:${synced ? 'synced' : 'behind'}`);

        // ── Mention detection ──
        const { mentions, newProcessedIds } = await this.checkMentions(
          project,
          slug,
          pr.id,
          prState?.lastActivityId ?? 0,
          new Set(prState?.processedMentionIds ?? []),
        );

        for (const mention of mentions) {
          try {
            await this.dispatchMention(mention, project, slug, pr, carrotConf);
          } catch (err) {
            // dispatchMention has already posted ❌ Failed: <err> to the user
            // before re-throwing. We catch here so a single mention failure
            // doesn't skip updatePrState below — otherwise the same mention
            // would re-fire on every subsequent poll.
            LogSink.warn(
              `PR #${pr.id}: mention ${mention.commentId ?? '(none)'} dispatch failed: ${err}`,
              TraceTags.POLLER,
            );
          }
        }

        // ── Auto-review (first time only) ──
        // Retries on failure, at most MAX_AUTO_REVIEW_ATTEMPTS times (each retry
        // costs a full review's LLM spend). The failure comment is updated
        // in-place each attempt, no spam. lastReviewedCommit === '' marks
        // "seen but not yet successfully reviewed".
        const reviewFailures = prState?.reviewFailures ?? 0;
        if (carrotConf.prReview && !prState?.lastReviewedCommit && reviewFailures < MAX_AUTO_REVIEW_ATTEMPTS) {
          try {
            await this.reviewer.reviewPr(
              project,
              slug,
              pr.id,
              pr.targetBranch,
              pr.sourceBranch,
              carrotConf.dockerImage,
              carrotConf.rulesFiles,
              carrotConf.generateFixPrompts,
              latestCommit,
              true, // auto-review: skip if a bot review for this commit is already on the PR
            );
          } catch (err) {
            // Record the failed attempt so the retry loop is bounded. Keep the
            // mention watermark and processed IDs as they were; leave
            // lastReviewedCommit empty so the next cycle retries (until cap).
            this.state.setPrState(repoKey, String(pr.id), {
              lastReviewedCommit: '',
              lastCheckedAt: new Date().toISOString(),
              lastActivityId: prState?.lastActivityId ?? 0,
              processedMentionIds: prState?.processedMentionIds,
              reviewFailures: reviewFailures + 1,
            });
            // Flush immediately: the failure count must survive a restart, or a
            // killed-and-restarted daemon would reset the retry budget and
            // re-review (re-comment) the PR from scratch every launch.
            this.state.save();
            if (reviewFailures + 1 >= MAX_AUTO_REVIEW_ATTEMPTS) {
              LogSink.warn(
                `PR #${pr.id}: auto-review failed ${reviewFailures + 1} time(s), giving up (mention @${this.botUsername} to retry)`,
                TraceTags.POLLER,
              );
            }
            throw err;
          }
        }

        await this.updatePrState(
          project,
          slug,
          repoKey,
          pr,
          latestCommit,
          prState?.processedMentionIds ?? [],
          newProcessedIds,
        );

        // Persist after every PR rather than once at cycle end. Review comments
        // are posted to the remote as we go, so the `lastReviewedCommit` marker
        // that suppresses a re-review must reach disk immediately — otherwise a
        // mid-cycle kill loses every reviewed PR's marker and the restarted
        // daemon re-reviews (re-comments on) PRs that already have comments.
        this.state.save();
      } catch (err) {
        LogSink.error(`Failed to process PR #${pr.id} in ${repoKey}: ${err}`, TraceTags.POLLER);
      }
    }

    if (prStateParts.length > 0) {
      LogSink.debug(`${repoKey} PR state: ${prStateParts.join(', ')}`, TraceTags.POLLER);
    }
  }

  private async dispatchMention(
    mention: IMentionCommand,
    project: string,
    slug: string,
    pr: IPullRequest,
    carrotConf: ICarrotConfig,
  ): Promise<void> {
    if (mention.commentId) {
      await this.provider.replyToComment(project, slug, pr.id, mention.commentId, `👀 On it...`);
    }

    try {
      const context = await this.gatherMentionContext(mention, project, slug, pr);
      const contextPayload = buildMentionContext(context);
      const route = await this.router.route(contextPayload);
      LogSink.info(`PR #${pr.id}: routed @mention → ${route.tool} (${route.reasoning})`, TraceTags.POLLER);

      // For explain/reply: generate response via LLM
      if (route.tool === 'explain' || route.tool === 'reply') {
        const llm = this.router.firstAvailableLlm;
        if (llm) {
          route.message = await this.router.generateResponse(llm, mention.message, contextPayload);
        }
      }

      const result = await executeMentionTool(route, mention, {
        reviewer: this.reviewer,
        handleRevert: (msg) => this.handleRevert(project, slug, pr.id, pr.sourceBranch, msg),
        postReply: async (text) => {
          if (mention.commentId) {
            await this.provider.replyToComment(project, slug, pr.id, mention.commentId, text);
          } else {
            await this.provider.postGeneralComment(project, slug, pr.id, text);
          }
        },
        pr: {
          project,
          slug,
          prId: pr.id,
          sourceBranch: pr.sourceBranch,
          sourceCommit: pr.sourceCommit,
          targetBranch: pr.targetBranch,
          dockerImage: carrotConf.dockerImage,
          rulesFiles: carrotConf.rulesFiles,
          generateFixPrompts: carrotConf.generateFixPrompts,
        },
      });

      if (
        mention.commentId &&
        result &&
        route.tool !== 'explain' &&
        route.tool !== 'reply' &&
        route.tool !== 'ignore'
      ) {
        const prefix = result.success ? '✅' : '❌';
        await this.provider.replyToComment(project, slug, pr.id, mention.commentId, `${prefix} ${result.message}`);
      }
    } catch (err) {
      if (mention.commentId) {
        await this.provider.replyToComment(project, slug, pr.id, mention.commentId, `❌ Failed: ${err}`);
      }
      throw err;
    }
  }

  private async updatePrState(
    project: string,
    slug: string,
    repoKey: string,
    pr: IPullRequest,
    latestCommit: string,
    previousProcessedIds: number[],
    newProcessedIds: number[],
  ): Promise<void> {
    const activities = await this.provider.getActivities(project, slug, pr.id);
    const maxActivityId = activities.reduce((max, a) => Math.max(max, a.id), 0);
    const allProcessed = [...new Set([...previousProcessedIds, ...newProcessedIds])].slice(-200);

    this.state.setPrState(repoKey, String(pr.id), {
      lastReviewedCommit: latestCommit,
      lastCheckedAt: new Date().toISOString(),
      lastActivityId: maxActivityId,
      processedMentionIds: allProcessed.length > 0 ? allProcessed : undefined,
    });
  }

  private async checkMentions(
    project: string,
    slug: string,
    prId: number,
    lastActivityId: number,
    processedMentionIds: Set<number>,
  ): Promise<{ mentions: IMentionCommand[]; newProcessedIds: number[] }> {
    const activities = await this.provider.getActivities(project, slug, prId);
    const mentions: IMentionCommand[] = [];
    const newProcessedIds: number[] = [];

    for (const activity of activities) {
      if (!activity.comment) continue;
      const replies = activity.comment.replies ?? [];
      const { anchor } = activity.comment;

      const textsToCheck: Array<{
        text: string;
        commentId: number;
        anchorFile?: string;
        anchorLine?: number;
        siblingReplies: string[];
      }> = [];

      // Top-level comments: gate by activity ID watermark
      if (activity.id > lastActivityId && activity.comment.text) {
        const cid = activity.comment.id;
        if (
          !processedMentionIds.has(cid) &&
          !isBotComment(activity.comment.authorUsername, this.botUsername) &&
          isBotMention(activity.comment.text, this.botUsername)
        ) {
          textsToCheck.push({
            text: activity.comment.text,
            commentId: cid,
            anchorFile: anchor?.path,
            anchorLine: anchor?.line,
            siblingReplies: replies.map((r) => r.text).filter(Boolean),
          });
        }
      }

      // Nested replies: always scan, dedup via getComment() child check.
      for (const reply of replies) {
        if (!isBotMention(reply.text ?? '', this.botUsername)) continue;
        if (isBotComment(reply.authorUsername, this.botUsername)) continue;
        if (processedMentionIds.has(reply.id)) continue;

        const fullComment = await this.provider.getComment(project, slug, prId, reply.id);
        const botAlreadyReplied = (fullComment?.replies ?? []).some((c: { authorUsername: string }) =>
          isBotComment(c.authorUsername, this.botUsername),
        );
        if (!botAlreadyReplied) {
          textsToCheck.push({
            text: reply.text,
            commentId: reply.id,
            anchorFile: anchor?.path,
            anchorLine: anchor?.line,
            siblingReplies: replies
              .filter((r) => r.id !== reply.id)
              .map((r) => r.text)
              .filter(Boolean),
          });
        }
      }

      // Build mentions from textsToCheck (no parsing — router decides)
      for (const item of textsToCheck) {
        newProcessedIds.push(item.commentId);
        mentions.push({
          type: 'reply', // placeholder — router determines actual tool
          message: item.text,
          prId,
          repoKey: `${project}/${slug}`,
          commentId: item.commentId,
          anchorFile: item.anchorFile,
          anchorLine: item.anchorLine,
          siblingReplies: item.siblingReplies,
        });
      }
    }

    return { mentions, newProcessedIds };
  }

  private async gatherMentionContext(
    mention: IMentionCommand,
    project: string,
    slug: string,
    pr: IPullRequest,
  ): Promise<IMentionContext> {
    const allComments = await this.provider.getComments(project, slug, pr.id);
    const botComments = allComments
      .filter((c) => isBotComment(c.authorUsername, this.botUsername))
      .map((c) => ({ path: c.anchor?.path, line: c.anchor?.line, text: c.text }));

    let anchorCode: string | undefined;
    let botCommentOnAnchor: string | undefined;
    if (mention.anchorFile && mention.anchorLine) {
      const fileContent = this.git.getFileFromBranch(project, slug, pr.sourceBranch, mention.anchorFile);
      if (fileContent) {
        anchorCode = sliceCodeAroundLine(fileContent, mention.anchorLine);
      }
      const match = botComments.find((c) => c.path === mention.anchorFile && c.line === mention.anchorLine);
      botCommentOnAnchor = match?.text;
    }

    return {
      mentionText: mention.message,
      anchorFile: mention.anchorFile,
      anchorLine: mention.anchorLine,
      anchorCode,
      botCommentOnAnchor,
      botCommentsOnPr: botComments,
      siblingReplies: mention.siblingReplies ?? [],
    };
  }

  private async handleRevert(
    project: string,
    slug: string,
    prId: number,
    branch: string,
    message?: string,
  ): Promise<string> {
    LogSink.info(`Revert requested for PR #${prId}: ${message ?? '(no details)'}`, TraceTags.REVIEWER);

    this.git.cloneOrFetch(project, slug);
    this.git.resetToRemoteBranch(project, slug, branch);
    const repoDir = this.git.getRepoDir(project, slug);

    // Try to find a commit hash in the message
    const hashMatch = message?.match(/\b([0-9a-f]{7,40})\b/i);

    if (!hashMatch) {
      // No hash specified — find the last bot commit on this branch
      try {
        const lastBotCommit = execFileSync(
          'git',
          ['log', '--oneline', `--author=${this.botUsername}`, '-1', '--format=%H'],
          { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' },
        ).trim();

        if (!lastBotCommit) {
          await this.provider.postGeneralComment(
            project,
            slug,
            prId,
            `Cannot revert: no commit hash specified and no bot commits found on this branch.`,
          );
          return 'Cannot revert: no bot commits found.';
        }

        return await this.doRevert(project, slug, prId, branch, repoDir, lastBotCommit);
      } catch {
        await this.provider.postGeneralComment(
          project,
          slug,
          prId,
          `Cannot revert: could not determine which commit to revert. Please specify a commit hash.`,
        );
        return 'Cannot revert: no commit specified.';
      }
    }

    return this.doRevert(project, slug, prId, branch, repoDir, hashMatch[1]);
  }

  private async doRevert(
    project: string,
    slug: string,
    prId: number,
    branch: string,
    repoDir: string,
    commitHash: string,
  ): Promise<string> {
    try {
      execFileSync('git', ['revert', '--no-edit', commitHash], { cwd: repoDir, stdio: 'pipe' });
    } catch (err) {
      const output = ((err as { stderr?: string }).stderr ?? '').slice(0, 500);
      execFileSync('git', ['revert', '--abort'], { cwd: repoDir, stdio: 'pipe' });
      await this.provider.postGeneralComment(
        project,
        slug,
        prId,
        `Cannot revert commit \`${commitHash.slice(0, 7)}\`: conflicts or errors.\n\n\`\`\`\n${output}\n\`\`\``,
      );
      return `Cannot revert \`${commitHash.slice(0, 7)}\`: ${output.slice(0, 100)}`;
    }

    // Create a carrot/ branch for the revert (don't push directly)
    const ts = branchTimestamp();
    const revertBranch = `carrot/revert-${prId}-${ts}`;
    execFileSync('git', ['checkout', '-b', revertBranch], { cwd: repoDir, stdio: 'pipe' });
    this.git.execGit(['push', 'origin', revertBranch], { cwd: repoDir, stdio: 'pipe', timeout: 120000 });

    const revertPrId = await this.provider.createFixPr(
      project,
      slug,
      `revert: undo commit ${commitHash.slice(0, 7)}`,
      `Reverts commit \`${commitHash}\` as requested.`,
      revertBranch,
      branch,
    );

    await this.provider.postGeneralComment(
      project,
      slug,
      prId,
      `Revert PR #${revertPrId} created to undo commit \`${commitHash.slice(0, 7)}\`.`,
    );
    return `Revert PR #${revertPrId} for commit \`${commitHash.slice(0, 7)}\`.`;
  }

  private writeHeartbeat(): void {
    try {
      fs.writeFileSync(this.heartbeatPath, new Date().toISOString());
    } catch (err) {
      LogSink.warn(`Failed to write heartbeat: ${err}`, TraceTags.POLLER);
    }
  }

  /** Wipe the shared temp dir to free disk space from previous cycles. */
  private cleanupTempDir(): void {
    try {
      if (fs.existsSync(BOT_TEMP_DIR)) {
        fs.rmSync(BOT_TEMP_DIR, { recursive: true, force: true });
      }
      fs.mkdirSync(BOT_TEMP_DIR, { recursive: true });
    } catch (err) {
      LogSink.warn(`Failed to clean temp dir ${BOT_TEMP_DIR}: ${err}`, TraceTags.POLLER);
    }
  }
}
