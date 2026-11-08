import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IModelUsage } from '../types';
import type { IPiTokenUsage } from './pi.service';
import type { MultiModelValidator } from './multi-model-validator';
import type { IReviewModel } from './reviewer.service';

/** What the fix loop needs from its caller. Shared by the PR fix flow and the ticket flow. */
export interface IFixLoopDeps {
  /** The pi model that applies changes. null → no revisions and no lint fix. */
  primaryModel: IReviewModel | null;
  /** Validator subset already picked for this operation. */
  validator: MultiModelValidator;
  toModelUsage: (rm: IReviewModel, usage: IPiTokenUsage) => IModelUsage;
  /** Label for log lines, e.g. "PR #12" or "ABC-123". */
  label: string;
}

export interface IFixLoopResult {
  earlyReturn: string | null;
  usage: IModelUsage[];
}

/**
 * Validate the working-tree changes with a 3-round improvement loop. Each
 * rejected round resets the tree and asks pi to revise with the council's
 * feedback. Returns an early-exit string when the change must be abandoned,
 * or null when it is approved.
 */
export async function runFixValidationLoop(
  deps: IFixLoopDeps,
  userMessage: string,
  originalDiff: string,
  repoDir: string,
  dockerImage: string | undefined,
  generateFixPrompts: boolean | undefined,
): Promise<IFixLoopResult> {
  const { validator, primaryModel, label } = deps;
  if (!validator.hasModels) {
    return { earlyReturn: null, usage: [] };
  }

  LogSink.info(
    `${label} fix: active validators (${validator.modelNames.length}): ${validator.modelNames.join(', ')}`,
    TraceTags.REVIEWER,
  );

  const allUsage: IModelUsage[] = [];
  const feedbackHistory: string[] = [];

  for (let round = 1; round <= 3; round++) {
    const status = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf-8' }).trim();
    if (!status) {
      return { earlyReturn: 'No changes were needed.', usage: allUsage };
    }

    const currentDiff = execSync('git diff', { cwd: repoDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const result = await validator.validateFix(userMessage, currentDiff);
    allUsage.push(...result.usage);

    if (result.approved) {
      LogSink.info(`${label}: fix approved by validators (round ${round})`, TraceTags.REVIEWER);
      return { earlyReturn: null, usage: allUsage };
    }

    feedbackHistory.push(`Round ${round}: ${result.summary}`);

    if (round < 3) {
      LogSink.info(`${label}: validators request changes (round ${round}), revising...`, TraceTags.REVIEWER);
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
        allUsage.push(deps.toModelUsage(primaryModel, revision.usage));
      } catch (err) {
        LogSink.error(`${label}: pi revision failed in round ${round}: ${err}`, TraceTags.REVIEWER);
        break;
      }
    }
  }

  const failure = await validator.summarizeFailure(feedbackHistory);
  allUsage.push(...failure.usage);

  let rejectionPrompt = '';
  if (generateFixPrompts) {
    try {
      const lastDiff = execSync('git diff', { cwd: repoDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      const { prompt, usage } = await validator.generateRejectionPrompt(userMessage, lastDiff, feedbackHistory);
      allUsage.push(...usage);
      if (prompt) {
        rejectionPrompt = `\n\n---\n**Suggested fix prompt:**\n\`\`\`\n${prompt}\n\`\`\``;
      }
    } catch (err) {
      LogSink.warn(`${label}: rejection prompt generation failed: ${err}`, TraceTags.REVIEWER);
    }
  }

  execSync('git checkout -- .', { cwd: repoDir, stdio: 'pipe' });
  execSync('git clean -fd', { cwd: repoDir, stdio: 'pipe' });
  return {
    earlyReturn: `Fix rejected after review: ${failure.summary}${rejectionPrompt}`,
    usage: allUsage,
  };
}

/** First lint script present in the repo's package.json: ci:lint, ci:stylecheck, lint. Null when none. */
export function resolveLintScript(repoDir: string): string | null {
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
  if (pkg.scripts?.['ci:lint']) return 'ci:lint';
  if (pkg.scripts?.['ci:stylecheck']) return 'ci:stylecheck';
  if (pkg.scripts?.lint) return 'lint';
  return null;
}

/** Run the repo's lint script in Docker; on failure, one pi pass that fixes only the reported lint errors. */
export function runLintAndFixErrors(
  deps: IFixLoopDeps,
  repoDir: string,
  diff: string,
  usageOut: IModelUsage[],
  dockerImage?: string,
): { failed: boolean; output: string } {
  const { primaryModel, label } = deps;
  if (!primaryModel) return { failed: false, output: '' };
  const script = resolveLintScript(repoDir);
  if (!script) return { failed: false, output: '' };

  LogSink.debug(`Running lint in Docker: npm run ${script}`, TraceTags.REVIEWER);
  const lintResult = primaryModel.pi.runLint(repoDir, script, dockerImage);
  if (lintResult.failed && lintResult.output) {
    LogSink.info(`${label}: lint failed after changes, running pi to fix lint errors`, TraceTags.REVIEWER);
    try {
      const lintFix = primaryModel.pi.fix(
        diff,
        repoDir,
        `The linter found errors after applying fixes. ONLY FIX THE LINT ERRORS below. Do NOT touch warnings. Do NOT make any other changes.\n\nLint output:\n${lintResult.output.slice(0, 8000)}`,
        dockerImage,
      );
      usageOut.push(deps.toModelUsage(primaryModel, lintFix.usage));
    } catch (err) {
      LogSink.warn(`${label}: lint fix attempt failed: ${err}`, TraceTags.REVIEWER);
    }
  }
  return lintResult;
}
