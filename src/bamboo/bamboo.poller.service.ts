import { execFileSync } from 'child_process';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import { BambooStateService } from './bamboo.state.service';
import { AuditService } from '../audit/audit.service';
import type { IGitProvider } from '../provider/provider';
import { CarrotConfigService } from '../config/carrot-config.service';
import { GitService } from '../reviewer/git.service';
import type { ICarrotConfig, IAuditSchedule } from '../config/carrot-config.types';
import type { IFixProposal } from '../audit/audit.types';
import { deduplicateProposals } from '../audit/audit.types';
import type { ChangelogService, IChangelogSummary } from '../audit/changelog.service';
import { BOT_BRANCH_PREFIXES, branchTimestamp } from '../constants';

export function buildAuditPrDescription(
  proposals: IFixProposal[],
  datePart: string,
  failedDirs: string[] = [],
  changelogSummaries: IChangelogSummary[] = [],
  removedOverrides: string[] = [],
): string {
  const {
    overrides,
    upgrades,
    upgradeParents,
    ghsasFixed: ghsasAddressed,
    ghsasUnfixable,
  } = deduplicateProposals(proposals);
  const changeCount = overrides.size + upgrades.size + upgradeParents.size;
  const lines = [`Automated audit fixes applied on ${datePart}.`, ''];

  if (changeCount > 0) {
    lines.push(`**Changes (${changeCount}):**`);
    for (const [key, version] of overrides) lines.push(`- override \`${key}\` → \`${version}\``);
    for (const [pkg, version] of upgrades) {
      const fromProposal = proposals.find((p) => p.strategy === 'upgrade' && p.upgradePackage === pkg);
      const fromVersion = fromProposal?.currentVersion;
      const versionStr = fromVersion ? `${fromVersion} → \`${version}\`` : `→ \`${version}\``;
      lines.push(`- upgrade \`${pkg}\` ${versionStr}`);
    }
    for (const [pkg, { version, isMajor }] of upgradeParents) {
      const majorTag = isMajor ? ' (MAJOR - potentially more dangerous)' : '';
      const fromProposal = proposals.find((p) => p.strategy === 'upgrade-parent' && p.upgradePackage === pkg);
      const fromVersion = fromProposal?.currentVersion;
      const versionStr = fromVersion ? `${fromVersion} → \`${version}\`` : `→ \`${version}\``;
      lines.push(`- upgrade-parent \`${pkg}\` ${versionStr}${majorTag}`);
    }
    lines.push('');
    lines.push(
      `Addresses ${ghsasAddressed.size} advisory/ies: ${[...ghsasAddressed].map((g) => `[${g}](https://github.com/advisories/${g})`).join(', ')}`,
    );
  }

  if (removedOverrides.length > 0) {
    lines.push('', `**Removed stale overrides (${removedOverrides.length}):**`);
    for (const key of removedOverrides) lines.push(`- \`${key}\``);
  }

  if (ghsasUnfixable.size > 0) {
    lines.push(
      '',
      `**Not auto-fixable (${ghsasUnfixable.size}):** ${[...ghsasUnfixable].map((g) => `[${g}](https://github.com/advisories/${g})`).join(', ')}`,
    );
  }
  if (failedDirs.length > 0) {
    lines.push(
      '',
      `**\`npm install\` failed in:** ${failedDirs.map((d) => `\`${d}\``).join(', ')} — fixes for these dirs were skipped.`,
    );
  }

  if (changelogSummaries.length > 0) {
    lines.push('', '---', '', '**Changelog summaries**', '');
    for (const cs of changelogSummaries) {
      const compareLink = cs.compareUrl ? ` ([compare](${cs.compareUrl}))` : '';
      lines.push(`> **${cs.packageName}** ${cs.fromVersion} → ${cs.toVersion}${compareLink}`);
      if (cs.summary) {
        for (const line of cs.summary.split('\n')) {
          lines.push(`> ${line}`);
        }
        const tokenInfo = cs.tokens
          ? ` (Summarizer, ${cs.tokens.input.toLocaleString()} input / ${cs.tokens.output.toLocaleString()} output tokens)`
          : '';
        lines.push(`>`);
        lines.push(
          `> _LLM-generated summary${tokenInfo} — may contain inaccuracies or reflect manipulated upstream content._`,
        );
      } else if (cs.skipReason) {
        lines.push(`> _Summary skipped: ${cs.skipReason}_`);
      }
      lines.push('');
    }
  }

  lines.push(
    '',
    '_AI review is excluded from audit fix decisions to prevent prompt injection from malicious packages. Changelog summaries above are LLM-generated from upstream release notes and are informational only._',
  );
  return lines.join('\n');
}

/**
 * AI review is explicitly excluded from audit fixes to prevent
 * prompt injection from malicious packages. All analysis and fix
 * application is purely programmatic.
 *
 * Discovery is PR-driven: for each repo with bambooFix enabled,
 * we check Bitbucket build statuses on open PR commits instead of
 * scanning all Bamboo plans. Fixes target the target branch (not individual
 * PR branches) so one fix benefits all open PRs.
 */
export class BambooPollerService {
  private readonly state: BambooStateService;
  private readonly audit: AuditService;
  private readonly provider: IGitProvider;
  private readonly carrotConfig: CarrotConfigService;
  private readonly git: GitService;
  private readonly intervalMs: number;
  private readonly changelog: ChangelogService | null;
  private shutdownRequested = false;

  constructor(opts: {
    state: BambooStateService;
    audit: AuditService;
    provider: IGitProvider;
    carrotConfig: CarrotConfigService;
    git: GitService;
    intervalMs: number;
    changelog?: ChangelogService;
  }) {
    this.state = opts.state;
    this.audit = opts.audit;
    this.provider = opts.provider;
    this.carrotConfig = opts.carrotConfig;
    this.git = opts.git;
    this.intervalMs = opts.intervalMs;
    this.changelog = opts.changelog ?? null;
  }

  public start(): void {
    this.state.load();
    LogSink.info(`Bamboo poller ready (driven by main poller cycle)`, TraceTags.BAMBOO);
  }

  public shutdown(): void {
    this.shutdownRequested = true;
    LogSink.info('Bamboo poller shutdown requested', TraceTags.BAMBOO);
  }

  // ── PR-driven build-status discovery ──────────────────────────────

  public async pollCycle(): Promise<void> {
    LogSink.info('Bamboo poll cycle starting...', TraceTags.BAMBOO);
    this.carrotConfig.clearCache();
    this.git.resetFetchMemo();
    this.state.pruneStale(30);

    try {
      const projects = await this.provider.listProjects();
      for (const project of projects) {
        if (this.shutdownRequested) break;
        const repos = await this.provider.listRepos(project.key);
        for (const repo of repos) {
          try {
            await this.pollRepoBuilds(project.key, repo.slug);
          } catch (err) {
            LogSink.error(`Bamboo: failed to poll builds for ${project.key}/${repo.slug}: ${err}`, TraceTags.BAMBOO);
          }
          try {
            await this.runScheduledAudits(project.key, repo.slug);
          } catch (err) {
            LogSink.error(`Bamboo: scheduled audit failed for ${project.key}/${repo.slug}: ${err}`, TraceTags.BAMBOO);
          }
        }
      }
    } catch (err) {
      LogSink.error(`Bamboo poll cycle failed: ${err}`, TraceTags.BAMBOO);
    }

    this.state.save();
    LogSink.info('Bamboo poll cycle complete.', TraceTags.BAMBOO);
  }

  private async pollRepoBuilds(project: string, slug: string): Promise<void> {
    const carrotConfig = await this.carrotConfig.getConfig(project, slug);
    if (!carrotConfig?.bambooFix) return;

    // Track target branches we've already analyzed this cycle.
    const analyzedTargets = new Set<string>();

    // ── Protected branch builds (direct, no PR required) ──
    await this.checkProtectedBranchBuilds(project, slug, carrotConfig, analyzedTargets);

    // ── PR-driven build discovery ──
    const prs = await this.provider.getOpenPullRequests(project, slug);
    if (prs.length > 0) {
      LogSink.debug(
        `Bamboo: checking build statuses for ${project}/${slug} (${prs.length} open PRs)`,
        TraceTags.BAMBOO,
      );

      for (const pr of prs) {
        if (this.shutdownRequested) break;
        if (pr.draft) continue;
        if (BOT_BRANCH_PREFIXES.some((p) => pr.sourceBranch.startsWith(p))) continue;

        const buildStatuses = await this.provider.getBuildStatuses(project, slug, pr.sourceCommit);

        for (const build of buildStatuses) {
          if (build.state !== 'failed') continue;

          const urlMatch = build.url.match(/\/browse\/([A-Za-z0-9]+-[A-Za-z0-9]+-\d+)/);
          const buildResultKey = urlMatch?.[1] ?? build.key;

          if (this.state.getBuildState(buildResultKey)) continue;

          const targetKey = `${project}/${slug}:${pr.targetBranch}`;
          if (analyzedTargets.has(targetKey)) {
            this.state.setBuildState(buildResultKey, {
              checkedAt: new Date().toISOString(),
              state: 'Failed',
              auditIssue: false,
              status: 'checked_ok',
            });
            continue;
          }
          analyzedTargets.add(targetKey);

          await this.analyzeAndFix(
            buildResultKey,
            {
              project,
              slug,
              prId: pr.id,
              branch: pr.sourceBranch,
              targetBranch: pr.targetBranch,
            },
            carrotConfig,
          );
        }
      }
    }
  }

  /** Check build statuses on protected branches directly (not via PRs). */
  private async checkProtectedBranchBuilds(
    project: string,
    slug: string,
    carrotConfig: ICarrotConfig,
    analyzedTargets: Set<string>,
  ): Promise<void> {
    const protectedBranches = await this.resolveProtectedBranches(project, slug, carrotConfig.protectedBranches);
    if (protectedBranches.length === 0) return;

    LogSink.debug(
      `Bamboo: checking protected branches for ${project}/${slug}: ${protectedBranches.join(', ')}`,
      TraceTags.BAMBOO,
    );

    for (const branch of protectedBranches) {
      if (this.shutdownRequested) break;

      const targetKey = `${project}/${slug}:${branch}`;
      if (analyzedTargets.has(targetKey)) continue;

      const commitHash = await this.provider.getBranchLatestCommit(project, slug, branch);
      if (!commitHash) {
        LogSink.debug(
          `Bamboo: protected branch ${branch} has no commit (branch may not exist), skipping`,
          TraceTags.BAMBOO,
        );
        continue;
      }

      const buildStatuses = await this.provider.getBuildStatuses(project, slug, commitHash);
      if (buildStatuses.length === 0) {
        LogSink.debug(
          `Bamboo: protected branch ${branch} (${commitHash.slice(0, 8)}) has no build statuses`,
          TraceTags.BAMBOO,
        );
      } else {
        const summary = buildStatuses.map((b) => `${b.key}=${b.state}`).join(', ');
        LogSink.debug(
          `Bamboo: protected branch ${branch} (${commitHash.slice(0, 8)}) builds: ${summary}`,
          TraceTags.BAMBOO,
        );
      }

      for (const build of buildStatuses) {
        if (build.state !== 'failed') continue;

        const urlMatch = build.url.match(/\/browse\/([A-Za-z0-9]+-[A-Za-z0-9]+-\d+)/);
        const buildResultKey = urlMatch?.[1] ?? build.key;

        if (this.state.getBuildState(buildResultKey)) {
          LogSink.debug(`Bamboo: build ${buildResultKey} already processed, skipping`, TraceTags.BAMBOO);
          continue;
        }

        analyzedTargets.add(targetKey);

        await this.analyzeAndFix(
          buildResultKey,
          {
            project,
            slug,
            targetBranch: branch,
          },
          carrotConfig,
        );

        break; // one failed build per branch is enough to trigger analysis
      }
    }
  }

  /** Resolve glob patterns (e.g. release/*) against actual repo branches. */
  private async resolveProtectedBranches(project: string, slug: string, patterns: string[]): Promise<string[]> {
    const hasGlob = patterns.some((p) => p.includes('*'));
    const allBranches = hasGlob ? await this.provider.listBranches(project, slug) : [];

    const matched = new Set<string>();
    for (const pattern of patterns) {
      if (!pattern.includes('*')) {
        matched.add(pattern);
      } else {
        const re = new RegExp(`^${pattern.replace(/\*/g, '[^/]+')}$`);
        for (const branch of allBranches) {
          if (re.test(branch)) matched.add(branch);
        }
      }
    }
    return [...matched];
  }

  // ── Scheduled audit checks (independent of build statuses) ────────

  private async runScheduledAudits(project: string, slug: string): Promise<void> {
    const carrotConfig = await this.carrotConfig.getConfig(project, slug);
    if (!carrotConfig?.auditSchedules || carrotConfig.auditSchedules.length === 0) return;

    for (const schedule of carrotConfig.auditSchedules) {
      if (this.shutdownRequested) break;

      const stateKey = `${project}/${slug}:${schedule.branch}`;
      if (!this.shouldRunScheduledAudit(schedule, stateKey)) continue;

      LogSink.info(`Scheduled audit: running on ${project}/${slug}@${schedule.branch}`, TraceTags.AUDIT);

      this.git.cloneOrFetch(project, slug);
      this.git.resetToRemoteBranch(project, slug, schedule.branch);
      const repoDir = this.git.getRepoDir(project, slug);

      const auditResult = await this.runAuditOnClone(repoDir, carrotConfig.packages, carrotConfig.dockerImage);

      if (auditResult.proposals.length === 0 || auditResult.applied === 0) {
        LogSink.info(
          `Scheduled audit: ${auditResult.proposals.length === 0 ? 'no findings' : 'no safe auto-fixes'} on ${stateKey}`,
          TraceTags.AUDIT,
        );
        this.state.setLastScheduledAudit(stateKey, new Date().toISOString());
        continue;
      }

      const failedDirs = this.verifyAndRevertFailures(repoDir, carrotConfig.packages, auditResult.failedDirs);
      if (!this.hasChangesLeft(repoDir)) {
        LogSink.warn(`Scheduled audit: no passing fixes left for ${stateKey}`, TraceTags.AUDIT);
        this.state.setLastScheduledAudit(stateKey, new Date().toISOString());
        continue;
      }

      await this.createOrUpdateAuditPr(
        repoDir,
        project,
        slug,
        schedule.branch,
        auditResult.applied,
        auditResult.proposals,
        failedDirs,
        auditResult.changelogSummaries,
        auditResult.removedOverrides,
      );
      this.state.setLastScheduledAudit(stateKey, new Date().toISOString());
      LogSink.info(`Scheduled audit: created/updated PR for ${stateKey}`, TraceTags.AUDIT);
    }
  }

  private shouldRunScheduledAudit(schedule: IAuditSchedule, stateKey: string): boolean {
    const now = new Date();

    const todayTarget = new Date(now);
    todayTarget.setHours(schedule.hour, schedule.minute, 0, 0);
    const diffMs = now.getTime() - todayTarget.getTime();
    const windowMs = Math.max(this.intervalMs, 30 * 60 * 1000);
    if (diffMs < 0 || diffMs > windowMs) return false;

    const lastRun = this.state.getLastScheduledAudit(stateKey);
    if (lastRun) {
      const daysSinceLast = (now.getTime() - new Date(lastRun).getTime()) / (24 * 60 * 60 * 1000);
      if (daysSinceLast < schedule.staleAfterDays) {
        LogSink.debug(
          `Scheduled audit: ${stateKey} last ran ${daysSinceLast.toFixed(1)}d ago (threshold: ${schedule.staleAfterDays}d), skipping`,
          TraceTags.AUDIT,
        );
        return false;
      }
    }

    return true;
  }

  // ── Target-branch audit analysis & fix ────────────────────────────

  private async analyzeAndFix(
    buildKey: string,
    target: { project: string; slug: string; targetBranch: string; prId?: number; branch?: string },
    carrotConfig: ICarrotConfig,
  ): Promise<void> {
    LogSink.info(`Failed build ${buildKey}: running audit on target branch ${target.targetBranch}`, TraceTags.BAMBOO);

    this.git.cloneOrFetch(target.project, target.slug);
    this.git.resetToRemoteBranch(target.project, target.slug, target.targetBranch);
    const repoDir = this.git.getRepoDir(target.project, target.slug);

    const auditResult = await this.runAuditOnClone(repoDir, carrotConfig.packages, carrotConfig.dockerImage);

    if (auditResult.proposals.length === 0) {
      this.markBuildChecked(buildKey);
      return;
    }

    if (auditResult.applied === 0) {
      if (target.prId != null) {
        await this.commentNoAutoFix(buildKey, {
          project: target.project,
          slug: target.slug,
          prId: target.prId,
          branch: target.branch ?? target.targetBranch,
        });
      } else {
        this.markBuildChecked(buildKey);
      }
      return;
    }

    const failedDirs = this.verifyAndRevertFailures(repoDir, carrotConfig.packages, auditResult.failedDirs);
    if (!this.hasChangesLeft(repoDir)) {
      this.markBuildChecked(buildKey);
      return;
    }

    const auditPrResult = await this.createOrUpdateAuditPr(
      repoDir,
      target.project,
      target.slug,
      target.targetBranch,
      auditResult.applied,
      auditResult.proposals,
      failedDirs,
      auditResult.changelogSummaries,
      auditResult.removedOverrides,
    );

    if (target.prId != null) {
      await this.provider.postGeneralComment(
        target.project,
        target.slug,
        target.prId,
        `Applied audit fix(es) in PR #${auditPrResult.prId} targeting \`${target.targetBranch}\`.`,
      );
    }

    this.state.setBuildState(buildKey, {
      checkedAt: new Date().toISOString(),
      state: 'Failed',
      auditIssue: true,
      prProject: target.project,
      prSlug: target.slug,
      prId: target.prId,
      prBranch: target.branch ?? target.targetBranch,
      status: 'fix_applied',
      vulnerabilities: auditResult.proposals,
    });
    this.state.save();
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async runAuditOnClone(
    repoDir: string,
    packages: string[],
    dockerImage?: string,
  ): Promise<{
    proposals: IFixProposal[];
    applied: number;
    failedDirs: string[];
    removedOverrides: string[];
    changelogSummaries: IChangelogSummary[];
  }> {
    const { proposals } = await this.audit.analyzeAll(repoDir, packages, dockerImage);
    const { applied, failedDirs } = this.audit.applyFixBatch(repoDir, proposals, dockerImage);

    // Cleanup stale overrides
    const removedOverrides = this.audit.cleanupStaleOverrides(repoDir, packages, dockerImage);

    // Gather changelog summaries
    let changelogSummaries: IChangelogSummary[] = [];
    if (this.changelog) {
      try {
        const appliedProposals = proposals.filter((p) => p.strategy !== 'cannot-fix');
        changelogSummaries = await this.changelog.summarizeProposals(appliedProposals);
      } catch (err) {
        LogSink.error(`Changelog summarization failed: ${err}`, TraceTags.AUDIT);
      }
    }

    return { proposals, applied, failedDirs, removedOverrides, changelogSummaries };
  }

  private verifyAndRevertFailures(repoDir: string, packages: string[], priorFailedDirs: string[]): string[] {
    const verifyFailedDirs: string[] = [];
    for (const dir of packages) {
      const result = this.audit.verifyAudit(`${repoDir}/${dir}`);
      if (!result.passes) {
        LogSink.warn(`Audit still fails in ${dir} after fixes — reverting`, TraceTags.AUDIT);
        try {
          execFileSync('git', ['checkout', '--', dir], { cwd: repoDir, stdio: 'pipe' });
        } catch {
          /* ignore */
        }
        verifyFailedDirs.push(dir);
      }
    }
    return [...new Set([...priorFailedDirs, ...verifyFailedDirs])];
  }

  private hasChangesLeft(repoDir: string): boolean {
    return execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' }).trim().length > 0;
  }

  private markBuildChecked(buildKey: string): void {
    this.state.setBuildState(buildKey, {
      checkedAt: new Date().toISOString(),
      state: 'Failed',
      auditIssue: true,
      status: 'checked_ok',
    });
  }

  private async commentNoAutoFix(
    buildKey: string,
    pr: { project: string; slug: string; prId: number; branch: string },
  ): Promise<void> {
    await this.provider.postGeneralComment(
      pr.project,
      pr.slug,
      pr.prId,
      `**Audit failure detected in build ${buildKey}.** No safe fixes could be applied automatically.\n\n_AI review is excluded from audit fixes to prevent prompt injection from malicious packages._`,
    );

    this.state.setBuildState(buildKey, {
      checkedAt: new Date().toISOString(),
      state: 'Failed',
      auditIssue: true,
      prProject: pr.project,
      prSlug: pr.slug,
      prId: pr.prId,
      prBranch: pr.branch,
      status: 'audit_detected',
    });
    this.state.save();
  }

  // ── Audit PR management (one per target branch, anti-spam) ────────

  private async createOrUpdateAuditPr(
    repoDir: string,
    project: string,
    slug: string,
    targetBranch: string,
    appliedCount: number,
    proposals: IFixProposal[],
    failedDirs: string[] = [],
    changelogSummaries: IChangelogSummary[] = [],
    removedOverrides: string[] = [],
  ): Promise<{ prId: number; auditBranch: string; isNew: boolean }> {
    const trackerKey = `${project}/${slug}:${targetBranch}`;
    const existing = this.state.getAuditPr(trackerKey);

    let reuseExisting = false;
    if (existing) {
      const isOpen = await this.provider.isPrOpen(project, slug, existing.prId);
      if (isOpen) {
        reuseExisting = true;
      } else {
        this.state.removeAuditPr(trackerKey);
      }
    }

    const now = new Date();
    const datePart = branchTimestamp();
    const { overrides, upgrades, upgradeParents } = deduplicateProposals(proposals);
    const changeCount = overrides.size + upgrades.size + upgradeParents.size;
    const prTitle = `fix(audit): ${changeCount} audit fix(es)`;

    if (reuseExisting && existing) {
      return this.updateExistingAuditPr(
        repoDir,
        project,
        slug,
        existing,
        trackerKey,
        prTitle,
        datePart,
        changeCount,
        now,
      );
    }

    return this.createNewAuditPr(
      repoDir,
      project,
      slug,
      targetBranch,
      trackerKey,
      prTitle,
      datePart,
      proposals,
      failedDirs,
      changelogSummaries,
      removedOverrides,
      now,
    );
  }

  private async updateExistingAuditPr(
    repoDir: string,
    project: string,
    slug: string,
    existing: { prId: number; auditBranch: string; targetBranch: string; project: string; slug: string },
    trackerKey: string,
    prTitle: string,
    datePart: string,
    changeCount: number,
    now: Date,
  ): Promise<{ prId: number; auditBranch: string; isNew: boolean }> {
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    const diff = execFileSync('git', ['diff', '--cached', '--stat'], {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    if (!diff) {
      LogSink.debug(`Audit PR for ${trackerKey} already up to date, skipping`, TraceTags.BAMBOO);
      return { prId: existing.prId, auditBranch: existing.auditBranch, isNew: false };
    }

    // Compare package.json files against the existing audit branch — skip push if identical
    try {
      this.git.execGit(['fetch', 'origin', existing.auditBranch], { cwd: repoDir, stdio: 'pipe' });
      const treeDiff = execFileSync('git', ['diff', `origin/${existing.auditBranch}`, '--name-only'], {
        cwd: repoDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
      const changedFiles = treeDiff ? treeDiff.split('\n') : [];
      const changedPkgJsons = changedFiles.filter((f) => f === 'package.json' || f.endsWith('/package.json'));
      if (changedPkgJsons.length === 0) {
        LogSink.debug(
          `Audit PR for ${trackerKey}: all package.json files unchanged vs audit branch, skipping push`,
          TraceTags.BAMBOO,
        );
        return { prId: existing.prId, auditBranch: existing.auditBranch, isNew: false };
      }
    } catch (err) {
      LogSink.warn(`Could not compare against audit branch ${existing.auditBranch}: ${err}`, TraceTags.BAMBOO);
    }

    LogSink.info(`Updating existing audit branch ${existing.auditBranch} for ${trackerKey}`, TraceTags.BAMBOO);
    execFileSync('git', ['checkout', '-B', existing.auditBranch], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', `${prTitle} (${datePart})`], { cwd: repoDir, stdio: 'pipe' });
    this.rebaseOntoLatestTarget(repoDir, trackerKey.split(':')[1]);
    this.git.execGit(['push', 'origin', existing.auditBranch, '--force'], { cwd: repoDir, stdio: 'pipe' });

    this.state.setAuditPr(trackerKey, { ...existing, lastUpdated: now.toISOString() });
    return { prId: existing.prId, auditBranch: existing.auditBranch, isNew: false };
  }

  private async createNewAuditPr(
    repoDir: string,
    project: string,
    slug: string,
    targetBranch: string,
    trackerKey: string,
    prTitle: string,
    datePart: string,
    proposals: IFixProposal[],
    failedDirs: string[],
    changelogSummaries: IChangelogSummary[],
    removedOverrides: string[],
    now: Date,
  ): Promise<{ prId: number; auditBranch: string; isNew: boolean }> {
    const auditBranch = `audit/${datePart}`;
    LogSink.info(`Creating new audit branch ${auditBranch} for ${trackerKey}`, TraceTags.BAMBOO);

    execFileSync('git', ['checkout', '-b', auditBranch], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', prTitle], { cwd: repoDir, stdio: 'pipe' });
    this.rebaseOntoLatestTarget(repoDir, targetBranch);
    this.git.execGit(['push', 'origin', auditBranch], { cwd: repoDir, stdio: 'pipe' });

    const description = buildAuditPrDescription(proposals, datePart, failedDirs, changelogSummaries, removedOverrides);
    const prId = await this.provider.createFixPr(project, slug, prTitle, description, auditBranch, targetBranch);

    this.state.setAuditPr(trackerKey, {
      auditBranch,
      prId,
      targetBranch,
      project,
      slug,
      lastUpdated: now.toISOString(),
    });
    return { prId, auditBranch, isNew: true };
  }

  private rebaseOntoLatestTarget(repoDir: string, targetBranch: string): void {
    try {
      this.git.execGit(['fetch', 'origin', targetBranch], { cwd: repoDir, stdio: 'pipe', timeout: 60000 });
      execFileSync('git', ['rebase', `origin/${targetBranch}`], { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
      LogSink.debug(`Rebased audit branch onto latest ${targetBranch}`, TraceTags.BAMBOO);
    } catch {
      try {
        execFileSync('git', ['rebase', '--abort'], { cwd: repoDir, stdio: 'pipe' });
      } catch {
        /* ignore */
      }
      LogSink.warn(`Rebase onto ${targetBranch} failed — pushing without rebase`, TraceTags.BAMBOO);
    }
  }
}
