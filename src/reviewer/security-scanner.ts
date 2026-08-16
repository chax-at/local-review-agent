import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import { BOT_TEMP_DIR } from '../constants';

export interface IScanFinding {
  tool: 'semgrep' | 'gitleaks';
  filePath: string;
  line: number;
  ruleId: string;
  message: string;
  severity: string;
}

/** Per-tool status carried alongside the rendered blob so operators can tell a clean scan from a failed one. */
export interface IScanOutcome {
  findings: string;
  /** Human-readable per-tool status for operator logging. */
  status: string;
}

/** What one tool contributed, plus whether it actually completed (vs. hit a caught failure). */
interface IToolResult {
  findings: IScanFinding[];
  ok: boolean;
}

// Resolved at module load: the scanner runs subprocesses with `cwd` set to the
// cloned repo, so anything relative to the app root must be absolute by then.
const SEMGREP_RULES_DIR = path.resolve('security-rules', 'semgrep');
const GITLEAKS_CONFIG_PATH = path.resolve('security-rules', 'gitleaks.toml');

/** Bounded per-tool timeout so a hung scanner can't stall a review indefinitely. */
export const SCAN_TIMEOUT_MS = 120_000;

/** Cap on captured scanner output — large repos can produce sizeable JSON. */
const MAX_SCAN_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Cap on findings rendered into the prompt, matching how every sibling context
 * path here is budgeted (MaxDiffLines, MaxExplorationTokens, ...). A PR touching
 * a vendored tree can otherwise produce hundreds of hits.
 */
export const MAX_RENDERED_FINDINGS = 50;

/**
 * Severity ordering used when truncating, covering the values these two tools
 * actually emit: gitleaks always reports `concern`, Semgrep reports
 * ERROR/WARNING/INFO. Anything unrecognized sorts last.
 */
const SEVERITY_RANK: Record<string, number> = {
  concern: 3,
  ERROR: 3,
  WARNING: 2,
  INFO: 1,
};

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 0;
}

/**
 * Semgrep's own diff-aware mode: only findings introduced since `baselineRef`
 * are reported, so pre-existing issues in the target branch never resurface.
 * The caller resolves `baselineRef` (a merge-base SHA, or an `origin/<branch>`
 * fallback) — this stays a dumb argv builder.
 * `--metrics=off` disables Semgrep's telemetry — this scans private repo
 * content and must not phone home. `--config` points at a local vendored
 * rules directory, never a live registry string, so scanning needs no network.
 * `target` is `.` in production: Semgrep runs with `cwd` set to the repo, both
 * so `--baseline-commit` finds a git repo at all and so reported paths come out
 * repo-relative, matching gitleaks' `File` coordinates.
 */
export function buildSemgrepArgs(rulesDir: string, baselineRef: string, target: string): string[] {
  return ['--config', rulesDir, `--baseline-commit=${baselineRef}`, '--json', '--quiet', '--metrics=off', target];
}

/**
 * Scans only the commit range unique to this PR (`--log-opts`), so secrets
 * already sitting in the target branch's history are never re-flagged.
 * gitleaks writes its JSON report to a file, not stdout, hence `reportPath`.
 */
export function buildGitleaksArgs(
  repoDir: string,
  configPath: string,
  targetBranch: string,
  sourceBranch: string,
  reportPath: string,
): string[] {
  return [
    'detect',
    '--source',
    repoDir,
    '--config',
    configPath,
    '--log-opts',
    `origin/${targetBranch}..origin/${sourceBranch}`,
    '--report-format',
    'json',
    '--report-path',
    reportPath,
    '--no-banner',
  ];
}

/** Masks a matched secret so it never reaches a file an LLM reads (and could echo into a posted PR comment). */
export function redactSecret(secret: string): string {
  if (!secret) return '(redacted)';
  return `${secret.slice(0, 4)}***`;
}

export function parseSemgrepOutput(json: string): IScanFinding[] {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.results)) return [];

  const findings: IScanFinding[] = [];
  for (const r of parsed.results) {
    if (typeof r?.path !== 'string' || typeof r?.start?.line !== 'number') continue;
    findings.push({
      tool: 'semgrep',
      filePath: r.path,
      line: r.start.line,
      ruleId: String(r.check_id ?? 'unknown'),
      message: String(r.extra?.message ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500),
      severity: String(r.extra?.severity ?? 'INFO'),
    });
  }
  return findings;
}

export function parseGitleaksOutput(json: string): IScanFinding[] {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const findings: IScanFinding[] = [];
  for (const f of parsed) {
    if (typeof f?.File !== 'string' || typeof f?.StartLine !== 'number') continue;
    const secret = String(f.Secret ?? f.Match ?? '');
    const description = String(f.Description ?? 'Potential secret').trim();
    findings.push({
      tool: 'gitleaks',
      filePath: f.File,
      line: f.StartLine,
      ruleId: String(f.RuleID ?? 'unknown'),
      message: `${description} (${redactSecret(secret)})`,
      severity: 'concern',
    });
  }
  return findings;
}

const TOOL_LABELS: Record<string, string> = {
  semgrep: 'Semgrep (static analysis)',
  gitleaks: 'gitleaks (secret scanning)',
};

/**
 * File paths come from the untrusted repo under review, and git permits
 * newlines (and backticks) in filenames — neither may break out of the markdown
 * line we embed them in.
 */
function sanitizeFilePath(filePath: string): string {
  return filePath.replace(/[\r\n]+/g, ' ').replace(/`/g, "'");
}

export function renderScannerFindings(findings: IScanFinding[]): string {
  if (findings.length === 0) return '';

  // Highest severity first, so truncation drops the least interesting hits.
  // Array.prototype.sort is stable, so same-severity findings keep tool order.
  const sorted = [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const kept = sorted.slice(0, MAX_RENDERED_FINDINGS);
  const omitted = sorted.length - kept.length;

  const byTool = new Map<string, IScanFinding[]>();
  for (const f of kept) {
    const list = byTool.get(f.tool);
    if (list) list.push(f);
    else byTool.set(f.tool, [f]);
  }

  const blocks: string[] = [];
  for (const [tool, items] of byTool) {
    const lines = items.map(
      (f) => `- \`${sanitizeFilePath(f.filePath)}:${f.line}\` [${f.ruleId}] (${f.severity}): ${f.message}`,
    );
    blocks.push([`## ${TOOL_LABELS[tool] ?? tool}`, ...lines].join('\n'));
  }
  if (omitted > 0) blocks.push(`*(${omitted} more finding(s) omitted)*`);
  return blocks.join('\n\n');
}

/**
 * Renders one tool's outcome for the operator log. Both tools degrade silently
 * by design, so "clean" and "crashed" must not read the same in the log.
 */
function describeToolResult(tool: string, result: IToolResult): string {
  if (!result.ok) return `${tool}: failed`;
  if (result.findings.length === 0) return `${tool}: ok (0 findings)`;
  return `${tool}: ${result.findings.length} finding(s)`;
}

/**
 * Diff-scoped static-analysis pass: runs Semgrep (SAST) and gitleaks (secrets)
 * against ONLY the commits/changes unique to this PR, before the review loop.
 * Both are host-installed binaries invoked directly — neither executes repo
 * code, so this carries the same trust level as `git grep` against an
 * untrusted diff.
 *
 * Never throws: a missing binary, a timeout, or unparsable output degrades
 * that tool's contribution to nothing rather than blocking the review.
 */
export class SecurityScanner {
  constructor(private readonly enabled: boolean) {}

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public async scan(repoDir: string, targetBranch: string, sourceBranch: string): Promise<IScanOutcome> {
    if (!this.enabled) return { findings: '', status: '' };

    const semgrep = this.runSemgrep(repoDir, targetBranch, sourceBranch);
    const gitleaks = this.runGitleaks(repoDir, targetBranch, sourceBranch);
    return {
      findings: renderScannerFindings([...semgrep.findings, ...gitleaks.findings]),
      status: `${describeToolResult('semgrep', semgrep)}, ${describeToolResult('gitleaks', gitleaks)}`,
    };
  }

  /**
   * Anchors the scan to the same commit the reviewed diff is anchored to —
   * `GitService.getDiff` uses three-dot (merge-base) semantics, and Semgrep's
   * `--baseline-commit` aborts unless the baseline is an ancestor of HEAD, which
   * a raw `origin/<targetBranch>` stops being as soon as the target advances.
   * Never throws: any failure falls back to the plain branch ref.
   */
  private resolveBaseline(repoDir: string, targetBranch: string, sourceBranch: string): string {
    try {
      const mergeBase = execFileSync('git', ['merge-base', `origin/${targetBranch}`, `origin/${sourceBranch}`], {
        cwd: repoDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (mergeBase) return mergeBase;
    } catch (err) {
      LogSink.warn(
        `Security scan: could not resolve merge-base for ${targetBranch}...${sourceBranch}: ${err}`,
        TraceTags.REVIEWER,
      );
    }
    return `origin/${targetBranch}`;
  }

  private runSemgrep(repoDir: string, targetBranch: string, sourceBranch: string): IToolResult {
    const baselineRef = this.resolveBaseline(repoDir, targetBranch, sourceBranch);
    try {
      // `cwd: repoDir` is load-bearing twice over: `--baseline-commit` needs a
      // git repo (the app's own cwd is not one), and it makes the `.` target
      // yield repo-relative paths in Semgrep's JSON.
      const output = execFileSync('semgrep', buildSemgrepArgs(SEMGREP_RULES_DIR, baselineRef, '.'), {
        cwd: repoDir,
        encoding: 'utf-8',
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: MAX_SCAN_OUTPUT_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { findings: parseSemgrepOutput(output), ok: true };
    } catch (err) {
      // A non-zero exit can still carry usable JSON on stdout; only warn if
      // nothing usable came back.
      const stdout = (err as { stdout?: Buffer | string } | null)?.stdout;
      const parsed = stdout ? parseSemgrepOutput(stdout.toString()) : [];
      if (parsed.length === 0) {
        LogSink.warn(`Security scan: semgrep produced no usable output: ${err}`, TraceTags.REVIEWER);
        return { findings: [], ok: false };
      }
      return { findings: parsed, ok: true };
    }
  }

  private runGitleaks(repoDir: string, targetBranch: string, sourceBranch: string): IToolResult {
    let tmpDir: string;
    try {
      fs.mkdirSync(BOT_TEMP_DIR, { recursive: true });
      tmpDir = fs.mkdtempSync(path.join(BOT_TEMP_DIR, 'scan-'));
    } catch (err) {
      LogSink.warn(`Security scan: gitleaks temp dir failed: ${err}`, TraceTags.REVIEWER);
      return { findings: [], ok: false };
    }

    const reportPath = path.join(tmpDir, 'gitleaks.json');
    try {
      try {
        execFileSync(
          'gitleaks',
          buildGitleaksArgs(repoDir, GITLEAKS_CONFIG_PATH, targetBranch, sourceBranch, reportPath),
          {
            encoding: 'utf-8',
            timeout: SCAN_TIMEOUT_MS,
            maxBuffer: MAX_SCAN_OUTPUT_BYTES,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      } catch (err) {
        // gitleaks exits 1 when it finds leaks — that's not a failure, the
        // report file is still written. Only a missing report means it crashed.
        if (!fs.existsSync(reportPath)) {
          LogSink.warn(`Security scan: gitleaks failed: ${err}`, TraceTags.REVIEWER);
          return { findings: [], ok: false };
        }
      }
      // A clean exit with no report means it ran and found nothing to report.
      if (!fs.existsSync(reportPath)) return { findings: [], ok: true };
      return { findings: parseGitleaksOutput(fs.readFileSync(reportPath, 'utf-8')), ok: true };
    } catch (err) {
      LogSink.warn(`Security scan: gitleaks read output failed: ${err}`, TraceTags.REVIEWER);
      return { findings: [], ok: false };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
