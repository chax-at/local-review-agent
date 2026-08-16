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

const SEMGREP_RULES_DIR = path.join('security-rules', 'semgrep');
const GITLEAKS_CONFIG_PATH = path.join('security-rules', 'gitleaks.toml');

/** Bounded per-tool timeout so a hung scanner can't stall a review indefinitely. */
export const SCAN_TIMEOUT_MS = 120_000;

/** Cap on captured scanner output — large repos can produce sizeable JSON. */
const MAX_SCAN_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Semgrep's own diff-aware mode: only findings introduced since `targetBranch`
 * are reported, so pre-existing issues in the target branch never resurface.
 * `--metrics=off` disables Semgrep's telemetry — this scans private repo
 * content and must not phone home. `--config` points at a local vendored
 * rules directory, never a live registry string, so scanning needs no network.
 */
export function buildSemgrepArgs(rulesDir: string, targetBranch: string, repoDir: string): string[] {
  return ['--config', rulesDir, `--baseline-commit=origin/${targetBranch}`, '--json', '--quiet', '--metrics=off', repoDir];
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

export function renderScannerFindings(findings: IScanFinding[]): string {
  if (findings.length === 0) return '';

  const byTool = new Map<string, IScanFinding[]>();
  for (const f of findings) {
    const list = byTool.get(f.tool);
    if (list) list.push(f);
    else byTool.set(f.tool, [f]);
  }

  const blocks: string[] = [];
  for (const [tool, items] of byTool) {
    const lines = items.map((f) => `- \`${f.filePath}:${f.line}\` [${f.ruleId}] (${f.severity}): ${f.message}`);
    blocks.push([`## ${TOOL_LABELS[tool] ?? tool}`, ...lines].join('\n'));
  }
  return blocks.join('\n\n');
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

  public async scan(repoDir: string, targetBranch: string, sourceBranch: string): Promise<string> {
    if (!this.enabled) return '';

    const findings = [...this.runSemgrep(repoDir, targetBranch), ...this.runGitleaks(repoDir, targetBranch, sourceBranch)];
    return renderScannerFindings(findings);
  }

  private runSemgrep(repoDir: string, targetBranch: string): IScanFinding[] {
    try {
      const output = execFileSync('semgrep', buildSemgrepArgs(SEMGREP_RULES_DIR, targetBranch, repoDir), {
        encoding: 'utf-8',
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: MAX_SCAN_OUTPUT_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return parseSemgrepOutput(output);
    } catch (err) {
      // A non-zero exit can still carry usable JSON on stdout; only warn if
      // nothing usable came back.
      const stdout = (err as { stdout?: Buffer | string } | null)?.stdout;
      const parsed = stdout ? parseSemgrepOutput(stdout.toString()) : [];
      if (parsed.length === 0) {
        LogSink.warn(`Security scan: semgrep produced no usable output: ${err}`, TraceTags.REVIEWER);
      }
      return parsed;
    }
  }

  private runGitleaks(repoDir: string, targetBranch: string, sourceBranch: string): IScanFinding[] {
    fs.mkdirSync(BOT_TEMP_DIR, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(BOT_TEMP_DIR, 'scan-'));
    const reportPath = path.join(tmpDir, 'gitleaks.json');
    try {
      try {
        execFileSync('gitleaks', buildGitleaksArgs(repoDir, GITLEAKS_CONFIG_PATH, targetBranch, sourceBranch, reportPath), {
          encoding: 'utf-8',
          timeout: SCAN_TIMEOUT_MS,
          maxBuffer: MAX_SCAN_OUTPUT_BYTES,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        // gitleaks exits 1 when it finds leaks — that's not a failure, the
        // report file is still written. Only a missing report means it crashed.
        if (!fs.existsSync(reportPath)) {
          LogSink.warn(`Security scan: gitleaks failed: ${err}`, TraceTags.REVIEWER);
          return [];
        }
      }
      if (!fs.existsSync(reportPath)) return [];
      return parseGitleaksOutput(fs.readFileSync(reportPath, 'utf-8'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
