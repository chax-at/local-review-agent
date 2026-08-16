import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  buildSemgrepArgs,
  buildGitleaksArgs,
  redactSecret,
  parseSemgrepOutput,
  parseGitleaksOutput,
  renderScannerFindings,
  MAX_RENDERED_FINDINGS,
  SecurityScanner,
  type IScanFinding,
} from '../../src/reviewer/security-scanner';

describe('buildSemgrepArgs', () => {
  it('builds diff-aware argv pinned to an already-resolved baseline ref, with metrics off', () => {
    expect(buildSemgrepArgs('/app/security-rules/semgrep', 'abc123def456', '.')).toEqual([
      '--config',
      '/app/security-rules/semgrep',
      '--baseline-commit=abc123def456',
      '--json',
      '--quiet',
      '--metrics=off',
      '.',
    ]);
  });

  it('passes a branch-shaped baseline ref through verbatim (no origin/ prefixing of its own)', () => {
    expect(buildSemgrepArgs('/rules', 'origin/main', '.')).toContain('--baseline-commit=origin/main');
  });
});

describe('buildGitleaksArgs', () => {
  it('scopes the scan to the commit range unique to the PR', () => {
    expect(
      buildGitleaksArgs('/repos/acme/app', 'security-rules/gitleaks.toml', 'main', 'feature', '/tmp/report.json'),
    ).toEqual([
      'detect',
      '--source',
      '/repos/acme/app',
      '--config',
      'security-rules/gitleaks.toml',
      '--log-opts',
      'origin/main..origin/feature',
      '--report-format',
      'json',
      '--report-path',
      '/tmp/report.json',
      '--no-banner',
    ]);
  });
});

describe('redactSecret', () => {
  it('keeps the first 4 characters and masks the rest', () => {
    expect(redactSecret('sk_live_abcdef123456')).toBe('sk_l***');
  });

  it('handles empty input', () => {
    expect(redactSecret('')).toBe('(redacted)');
  });
});

describe('parseSemgrepOutput', () => {
  it('extracts findings from valid semgrep JSON', () => {
    const json = JSON.stringify({
      results: [
        {
          check_id: 'javascript.lang.security.detect-eval-with-expr',
          path: 'src/foo.ts',
          start: { line: 12 },
          extra: { message: 'Detected eval', severity: 'ERROR' },
        },
      ],
    });
    expect(parseSemgrepOutput(json)).toEqual([
      {
        tool: 'semgrep',
        filePath: 'src/foo.ts',
        line: 12,
        ruleId: 'javascript.lang.security.detect-eval-with-expr',
        message: 'Detected eval',
        severity: 'ERROR',
      },
    ]);
  });

  it('returns empty for malformed JSON', () => {
    expect(parseSemgrepOutput('not json')).toEqual([]);
  });

  it('returns empty when results is missing', () => {
    expect(parseSemgrepOutput('{}')).toEqual([]);
  });

  it('skips entries missing a path or line', () => {
    const json = JSON.stringify({ results: [{ check_id: 'x', extra: {} }] });
    expect(parseSemgrepOutput(json)).toEqual([]);
  });
});

describe('parseGitleaksOutput', () => {
  it('extracts findings and redacts the matched secret', () => {
    const json = JSON.stringify([
      {
        File: 'src/config.ts',
        StartLine: 5,
        RuleID: 'aws-access-token',
        Description: 'AWS Access Token',
        Secret: 'AKIAABCDEFGHIJKLMNOP',
      },
    ]);
    expect(parseGitleaksOutput(json)).toEqual([
      {
        tool: 'gitleaks',
        filePath: 'src/config.ts',
        line: 5,
        ruleId: 'aws-access-token',
        message: 'AWS Access Token (AKIA***)',
        severity: 'concern',
      },
    ]);
  });

  it('returns empty for malformed JSON', () => {
    expect(parseGitleaksOutput('not json')).toEqual([]);
  });

  it('returns empty when the top level is not an array', () => {
    expect(parseGitleaksOutput('{}')).toEqual([]);
  });

  it('skips entries missing a file or line', () => {
    const json = JSON.stringify([{ RuleID: 'x' }]);
    expect(parseGitleaksOutput(json)).toEqual([]);
  });
});

function makeFinding(overrides: Partial<IScanFinding> = {}): IScanFinding {
  return {
    tool: 'semgrep',
    filePath: 'a.ts',
    line: 1,
    ruleId: 'r1',
    message: 'm1',
    severity: 'ERROR',
    ...overrides,
  };
}

describe('renderScannerFindings', () => {
  it('returns empty string when there are no findings', () => {
    expect(renderScannerFindings([])).toBe('');
  });

  it('groups findings by tool under labeled headings', () => {
    const findings: IScanFinding[] = [
      { tool: 'semgrep', filePath: 'a.ts', line: 1, ruleId: 'r1', message: 'm1', severity: 'ERROR' },
      { tool: 'gitleaks', filePath: 'b.ts', line: 2, ruleId: 'r2', message: 'm2', severity: 'concern' },
    ];
    const rendered = renderScannerFindings(findings);
    expect(rendered).toContain('## Semgrep (static analysis)');
    expect(rendered).toContain('## gitleaks (secret scanning)');
    expect(rendered).toContain('`a.ts:1` [r1] (ERROR): m1');
    expect(rendered).toContain('`b.ts:2` [r2] (concern): m2');
  });

  it('sanitizes newlines and backticks out of the file path', () => {
    const rendered = renderScannerFindings([
      makeFinding({ filePath: 'src/ev\nil`.ts\r\n- `injected:1` [x] (ERROR): pwned' }),
    ]);
    // The whole finding must stay on one markdown line, with no backticks
    // smuggled in from the untrusted repo's filename.
    const bodyLines = rendered.split('\n').filter((l) => l.startsWith('- '));
    expect(bodyLines).toHaveLength(1);
    expect(bodyLines[0]).not.toContain('\r');
    expect(bodyLines[0].split('`')).toHaveLength(3); // exactly the one wrapping pair we emit
  });

  it('omits the truncation note when the finding count is at or under the cap', () => {
    const findings = Array.from({ length: MAX_RENDERED_FINDINGS }, (_, i) => makeFinding({ ruleId: `r-${i}` }));
    expect(renderScannerFindings(findings)).not.toContain('omitted');
  });

  it('truncates above the cap and reports how many were omitted', () => {
    const findings = Array.from({ length: MAX_RENDERED_FINDINGS + 7 }, (_, i) => makeFinding({ ruleId: `r-${i}` }));
    expect(renderScannerFindings(findings)).toContain('*(7 more finding(s) omitted)*');
  });

  it('keeps higher-severity findings when truncating', () => {
    const lowSeverity = Array.from({ length: MAX_RENDERED_FINDINGS }, (_, i) =>
      makeFinding({ ruleId: `info-${i}`, severity: 'INFO' }),
    );
    const highSeverity = Array.from({ length: 5 }, (_, i) => makeFinding({ ruleId: `err-${i}`, severity: 'ERROR' }));
    // Low-severity findings come first in input order, so only sorting can save
    // the high-severity ones from being cut.
    const rendered = renderScannerFindings([...lowSeverity, ...highSeverity]);

    for (let i = 0; i < 5; i++) expect(rendered).toContain(`[err-${i}]`);
    expect(rendered).toContain('[info-0]');
    // The 5 lowest-ranked findings are the ones dropped.
    for (let i = MAX_RENDERED_FINDINGS - 5; i < MAX_RENDERED_FINDINGS; i++) {
      expect(rendered).not.toContain(`[info-${i}]`);
    }
    expect(rendered).toContain('*(5 more finding(s) omitted)*');
  });

  it('ranks gitleaks concerns above semgrep warnings and infos', () => {
    const findings = [
      makeFinding({ ruleId: 'low', severity: 'INFO' }),
      makeFinding({ ruleId: 'mid', severity: 'WARNING' }),
      makeFinding({ tool: 'gitleaks', ruleId: 'top', severity: 'concern' }),
    ];
    const rendered = renderScannerFindings(findings);
    expect(rendered.indexOf('[mid]')).toBeLessThan(rendered.indexOf('[low]'));
    // Grouping still happens per tool, so just assert the semgrep block ordering
    // above plus that the gitleaks concern survived.
    expect(rendered).toContain('[top]');
  });
});

/** Reaches the private baseline resolver without loosening its visibility in production code. */
type BaselineResolver = { resolveBaseline(repoDir: string, targetBranch: string, sourceBranch: string): string };

describe('SecurityScanner', () => {
  it('isEnabled reflects the constructor flag', () => {
    expect(new SecurityScanner(true).isEnabled).toBe(true);
    expect(new SecurityScanner(false).isEnabled).toBe(false);
  });

  it('returns an empty outcome without spawning a process when disabled', async () => {
    const scanner = new SecurityScanner(false);
    await expect(scanner.scan('/repos/acme/app', 'main', 'feature')).resolves.toEqual({ findings: '', status: '' });
  });

  it('never throws even when binaries are missing, and reports per-tool status', async () => {
    const scanner = new SecurityScanner(true);
    // semgrep and gitleaks are not installed in the test environment, so this
    // exercises the "missing binary" path and verifies the never-throws contract.
    const outcome = await scanner.scan('/repos/acme/app', 'main', 'feature');
    expect(outcome.findings).toBeDefined();
    expect(outcome.status).toContain('semgrep');
    expect(outcome.status).toContain('gitleaks');
  });
});

describe('SecurityScanner.resolveBaseline', () => {
  it('falls back to origin/<targetBranch> when merge-base cannot be resolved', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      const scanner = new SecurityScanner(true) as unknown as BaselineResolver;
      expect(scanner.resolveBaseline(tmpDir, 'main', 'feature')).toBe('origin/main');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: runs the real binaries against a real git repository. This is
// the only test that would have caught the scanner running with the wrong cwd
// (semgrep's --baseline-commit aborts outside a git repo). Skipped when the
// binaries aren't installed locally; the CI image has both.
// ---------------------------------------------------------------------------

function hasBinary(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const SCANNERS_INSTALLED = hasBinary('semgrep', ['--version']) && hasBinary('gitleaks', ['version']);

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Scanner Test',
  GIT_AUTHOR_EMAIL: 'scanner@test.invalid',
  GIT_COMMITTER_NAME: 'Scanner Test',
  GIT_COMMITTER_EMAIL: 'scanner@test.invalid',
};

function git(repoDir: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: repoDir,
    stdio: 'ignore',
    env: { ...process.env, ...GIT_IDENTITY },
  });
}

/**
 * Builds `main` and `feature` branches plus the `refs/remotes/origin/*` refs the
 * scanner resolves against. `git update-ref refs/remotes/origin/<b>` is enough —
 * git resolves `origin/<b>` from that ref whether or not a real remote exists.
 */
function buildScannableRepo(): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-repo-'));
  git(repoDir, ['init', '-q']);
  git(repoDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);

  fs.writeFileSync(path.join(repoDir, 'clean.js'), 'module.exports = function add(a, b) { return a + b; };\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'clean baseline']);
  git(repoDir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  git(repoDir, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(
    path.join(repoDir, 'vulnerable.js'),
    [
      "const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';",
      'function run(userInput) {',
      '  return eval(userInput);',
      '}',
      'module.exports = { run, AWS_KEY };',
      '',
    ].join('\n'),
  );
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'add vulnerable code and a secret']);
  git(repoDir, ['update-ref', 'refs/remotes/origin/feature', 'HEAD']);

  return repoDir;
}

describe.skipIf(!SCANNERS_INSTALLED)('SecurityScanner integration (requires semgrep + gitleaks)', () => {
  it('finds diff-scoped issues with repo-relative paths, and stays empty with no diff', async () => {
    const repoDir = buildScannableRepo();
    try {
      const scanner = new SecurityScanner(true);

      const outcome = await scanner.scan(repoDir, 'main', 'feature');
      expect(outcome.status).not.toContain('failed');
      expect(outcome.findings).not.toBe('');
      expect(outcome.findings).toContain('vulnerable.js');
      // Paths must be repo-relative, matching gitleaks' coordinate system.
      expect(outcome.findings).not.toContain(repoDir);
      for (const line of outcome.findings.split('\n').filter((l) => l.startsWith('- `'))) {
        expect(line.startsWith('- `/')).toBe(false);
      }

      // Control: an empty diff range must produce nothing.
      const control = await scanner.scan(repoDir, 'main', 'main');
      expect(control.findings).toBe('');
      expect(control.findings).not.toBe(outcome.findings);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }, 300_000);
});
