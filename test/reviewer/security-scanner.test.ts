import { describe, it, expect } from 'vitest';
import {
  buildSemgrepArgs,
  buildGitleaksArgs,
  redactSecret,
  parseSemgrepOutput,
  parseGitleaksOutput,
  renderScannerFindings,
  SecurityScanner,
  type IScanFinding,
} from '../../src/reviewer/security-scanner';

describe('buildSemgrepArgs', () => {
  it('builds diff-aware argv pinned to the target branch, with metrics off', () => {
    expect(buildSemgrepArgs('security-rules/semgrep', 'main', '/repos/acme/app')).toEqual([
      '--config',
      'security-rules/semgrep',
      '--baseline-commit=origin/main',
      '--json',
      '--quiet',
      '--metrics=off',
      '/repos/acme/app',
    ]);
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
});

describe('SecurityScanner', () => {
  it('isEnabled reflects the constructor flag', () => {
    expect(new SecurityScanner(true).isEnabled).toBe(true);
    expect(new SecurityScanner(false).isEnabled).toBe(false);
  });

  it('returns empty string without spawning a process when disabled', async () => {
    const scanner = new SecurityScanner(false);
    await expect(scanner.scan('/repos/acme/app', 'main', 'feature')).resolves.toBe('');
  });

  it('never throws even when binaries are missing', async () => {
    const scanner = new SecurityScanner(true);
    // semgrep and gitleaks are not installed in test environment, so this
    // exercises the "missing binary" path and verifies the never-throws contract
    await expect(scanner.scan('/repos/acme/app', 'main', 'feature')).resolves.toBeDefined();
  });
});
