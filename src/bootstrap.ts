// src/bootstrap.ts
import * as path from 'path';
import LogSink from '@chax-at/log-sink';
import config from './safe-config';
import { TraceTags } from './log/tags';
import type { IGitProvider, IGitConfig } from './provider/provider';
import { StateService } from './poller/state.service';
import { PollerService } from './poller/poller.service';
import { ReviewerService, type IReviewModel } from './reviewer/reviewer.service';
import { GitService } from './reviewer/git.service';
import { PiService } from './reviewer/pi.service';
import { ensurePiRunnerImage } from './reviewer/pi-runner-image';
import { LlmClient, type ILlmConfig } from './reviewer/llm-client';
import { MultiModelValidator } from './reviewer/multi-model-validator';
import { InfoGatherer } from './reviewer/info-gatherer';
import { ContextExplorer } from './reviewer/context-explorer';
import { SecurityScanner } from './reviewer/security-scanner';
import { JiraService } from './jira/jira.service';
import { createHeartbeat } from './heartbeat';
import { FindingDeduplicator } from './reviewer/finding-deduplicator';
import { CarrotConfigService } from './config/carrot-config.service';
import { MentionRouter } from './poller/mention-router';
import { parseRoles, isCorrectnessCovered } from './reviewer/personas';

export interface IBootstrapInput {
  provider: IGitProvider;
  botUsername: string;
  gitConfig: IGitConfig;
}

export function requireNonEmpty(value: string, envVarName: string): string {
  if (!value || value.trim() === '') {
    LogSink.error(`${envVarName} is not set. Exiting.`, TraceTags.ERROR);
    process.exit(1);
  }
  return value;
}

export async function buildAndStart(input: IBootstrapInput): Promise<void> {
  const { provider, botUsername, gitConfig } = input;

  ensurePiRunnerImage();

  const intervalMs = config.get('Polling.IntervalMs');
  const maxDiffLines = config.get('Review.MaxDiffLines');
  const maxFileLines = config.get('Review.MaxFileLines');
  const maxInfoTokens = config.get('Review.MaxInfoTokens');
  const maxExplorationTokens = config.get('Review.MaxExplorationTokens');
  const maxValidators = config.get('Review.MaxValidators');
  const workDir = config.get('WorkDir');
  const dataDir = config.get('DataDir');

  LogSink.debug(
    `Config: bot=${botUsername} interval=${intervalMs}ms maxDiffLines=${maxDiffLines} maxFileLines=${maxFileLines}`,
    TraceTags.DEBUG,
  );
  LogSink.debug(`Config: workDir=${workDir} dataDir=${dataDir}`, TraceTags.DEBUG);

  const stateService = new StateService(dataDir);
  const gitService = new GitService(workDir, gitConfig);

  type ModelKey = 'Model1' | 'Model2' | 'Model3' | 'Model4';
  const modelKeys: ModelKey[] = ['Model1', 'Model2', 'Model3', 'Model4'];

  const buildLlmClient = (key: ModelKey): LlmClient | null => {
    // Skip models flagged Validate=false (e.g. responses-API codex deployments
    // that don't speak /chat/completions — they belong in the review pool only).
    if (config.get(`${key}.Validate`) === false) return null;
    const apiKey = config.get(`${key}.ApiKey`);
    const apiBase = config.get(`${key}.ApiBase`);
    const model = config.get(`${key}.Model`);
    if (!apiKey || !apiBase || !model) return null;
    return new LlmClient({
      name: config.get(`${key}.Name`) || key,
      apiKey,
      apiBase,
      model,
      authHeader: config.get(`${key}.AuthHeader`) || undefined,
      supportsStructuredOutput: config.get(`${key}.SupportsStructuredOutput`),
      maxTokenParam: config.get(`${key}.MaxTokenParam`) as ILlmConfig['maxTokenParam'],
      inputCostPer1M: config.get(`${key}.InputTokenCostPer1M`),
      outputCostPer1M: config.get(`${key}.OutputTokenCostPer1M`),
    });
  };

  const buildReviewModel = (key: ModelKey): IReviewModel | null => {
    if (!config.get(`${key}.Review`)) return null;
    const model = config.get(`${key}.Model`);
    const apiKey = config.get(`${key}.ApiKey`);
    const apiBase = config.get(`${key}.ApiBase`);
    if (!model || !apiKey || !apiBase) return null;
    const pi = new PiService(
      model,
      config.get(`${key}.Provider`),
      config.get(`${key}.TimeoutMs`),
      config.get(`${key}.DockerImage`),
      apiKey,
      apiBase,
    );
    const name = config.get(`${key}.Name`) || key;
    return {
      name,
      pi,
      roles: parseRoles(config.get(`${key}.Roles`), name),
      inputCostPer1M: config.get(`${key}.InputTokenCostPer1M`),
      outputCostPer1M: config.get(`${key}.OutputTokenCostPer1M`),
    };
  };

  const validators = modelKeys.map(buildLlmClient).filter(Boolean) as LlmClient[];
  const reviewModels = modelKeys.map(buildReviewModel).filter(Boolean) as IReviewModel[];

  if (reviewModels.length > 0 && !isCorrectnessCovered(reviewModels.map((m) => m.roles))) {
    LogSink.warn(
      'No review model covers correctness (no "correctness" or "generic" role) — reviews will not hunt for bugs. ' +
        'Intentional for specialized deployments; otherwise add the role to a review-enabled model.',
      TraceTags.PI,
    );
  }

  LogSink.debug(`Validation models: ${validators.map((v) => v.name).join(', ') || 'none'}`, TraceTags.DEBUG);
  LogSink.debug(`Review models: ${reviewModels.map((m) => m.name).join(', ') || 'none'}`, TraceTags.DEBUG);
  if (reviewModels.length === 0) {
    LogSink.warn('No review-enabled models configured — PR review and fixes are disabled.', TraceTags.PI);
  }

  const multiValidator = new MultiModelValidator(validators);
  // Info-gatherer runs once per PR before validation, asking the first available
  // validator what extra files/symbols would help judge the findings.
  const infoGatherer = new InfoGatherer(validators[0] ?? null, maxInfoTokens);
  if (infoGatherer.isEnabled) {
    LogSink.debug(`Info gatherer: ${validators[0].name} (budget ${maxInfoTokens} tokens)`, TraceTags.DEBUG);
  } else {
    LogSink.debug(`Info gatherer: disabled (no validator or MaxInfoTokens=0)`, TraceTags.DEBUG);
  }

  // Context explorer runs once per PR before the review pass, walking the repo
  // from the diff (callers, type definitions) so the tool-less reviewers get
  // cross-file context. Uses the first available validator, like the gatherer.
  const contextExplorer = new ContextExplorer(validators[0] ?? null, maxExplorationTokens);
  if (contextExplorer.isEnabled) {
    LogSink.debug(`Context explorer: ${validators[0].name} (budget ${maxExplorationTokens} tokens)`, TraceTags.DEBUG);
  } else {
    LogSink.debug(`Context explorer: disabled (no validator or MaxExplorationTokens=0)`, TraceTags.DEBUG);
  }

  const securityScannersEnabled = config.get('Review.SecurityScannersEnabled');
  const securityScanner = new SecurityScanner(securityScannersEnabled);
  LogSink.debug(`Security scanner: ${securityScanner.isEnabled ? 'enabled' : 'disabled'}`, TraceTags.DEBUG);

  // Finding deduplicator: a single LLM (the first validator) collapses same-run
  // duplicate findings before the validation council sees them.
  const deduplicator = new FindingDeduplicator(validators[0] ?? null);
  LogSink.debug(
    `Finding deduplicator: ${deduplicator.isEnabled ? validators[0].name : 'disabled (no validator)'}`,
    TraceTags.DEBUG,
  );

  const routerLlmChain: LlmClient[] = [...validators];
  const mentionRouter = new MentionRouter(routerLlmChain);

  const pingTargets = [...validators];
  if (pingTargets.length > 0) {
    LogSink.info('Checking LLM connectivity...', TraceTags.DEBUG);
    const pingResults = await Promise.allSettled(pingTargets.map((v) => v.ping()));
    for (let i = 0; i < pingResults.length; i++) {
      if (pingResults[i].status === 'fulfilled') {
        LogSink.info(`  ${pingTargets[i].name}: ok`, TraceTags.DEBUG);
      } else {
        const { reason } = pingResults[i] as PromiseRejectedResult;
        LogSink.warn(`  ${pingTargets[i].name}: FAILED - ${reason}`, TraceTags.PI);
      }
    }
  }

  // Jira ticket context: read-only, optional. When configured, the reviewer
  // pulls the PR's originating ticket (key parsed from branch/title/description)
  // into pr-context.md for the review pass.
  const jiraService = new JiraService(
    config.get('Jira.BaseUrl'),
    config.get('Jira.Email'),
    config.get('Jira.ApiToken'),
    config
      .get('Jira.ProjectKeys')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
  );
  LogSink.debug(
    `Jira: ${jiraService.isEnabled ? `${config.get('Jira.BaseUrl')} (keys: ${config.get('Jira.ProjectKeys') || 'any'})` : 'disabled'}`,
    TraceTags.DEBUG,
  );
  // Half-configured Jira silently yields no ticket context — that looks like
  // "Jira has nothing to say about this PR", so make it loud.
  const jiraBaseUrl = config.get('Jira.BaseUrl').trim();
  const jiraToken = config.get('Jira.ApiToken').trim();
  if (jiraBaseUrl !== '' && jiraToken === '') {
    LogSink.warn(
      `Jira is disabled: JIRA_BASE_URL is set (${jiraBaseUrl}) but JIRA_API_TOKEN is empty — no ticket context will be attached`,
      TraceTags.JIRA,
    );
  } else if (jiraBaseUrl === '' && jiraToken !== '') {
    LogSink.warn(
      'Jira is disabled: JIRA_API_TOKEN is set but JIRA_BASE_URL is empty — no ticket context will be attached',
      TraceTags.JIRA,
    );
  }

  const carrotConfigService = new CarrotConfigService(provider);

  const heartbeat = createHeartbeat(path.join(dataDir, 'heartbeat'));

  const reviewerService = new ReviewerService(
    provider,
    gitService,
    reviewModels,
    botUsername,
    maxDiffLines,
    maxFileLines,
    multiValidator,
    carrotConfigService,
    infoGatherer,
    deduplicator,
    maxValidators,
    contextExplorer,
    securityScanner,
    jiraService,
    heartbeat,
  );

  const poller = new PollerService(
    provider,
    stateService,
    reviewerService,
    carrotConfigService,
    gitService,
    mentionRouter,
    botUsername,
    intervalMs,
    heartbeat,
  );

  const shutdown = (): void => {
    LogSink.info('Shutdown signal received...', TraceTags.DEBUG);
    poller.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (reason) => {
    LogSink.error(`Unhandled Rejection: ${reason}`, TraceTags.ERROR);
  });

  await poller.start();
}
