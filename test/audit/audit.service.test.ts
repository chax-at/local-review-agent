import { describe, it, expect } from 'vitest';
import {
  safeVersionFromVulnRange,
  getGhsaId,
  collectHighFindings,
  groupFindingsByVuln,
  packageNameFromOverrideKey,
} from '../../src/audit/audit.service';

describe('safeVersionFromVulnRange', () => {
  it('handles <X.Y.Z', () => {
    expect(safeVersionFromVulnRange('<2.1.1')).toBe('2.1.1');
  });

  it('handles <=X.Y.Z with range syntax (avoids inventing non-existent versions)', () => {
    expect(safeVersionFromVulnRange('<=7.0.2')).toBe('>7.0.2');
  });

  it('extracts upper bound from compound ranges', () => {
    expect(safeVersionFromVulnRange('>=7.0.0 <7.0.3')).toBe('7.0.3');
    expect(safeVersionFromVulnRange('>=4.2.0 <4.2.5')).toBe('4.2.5');
    expect(safeVersionFromVulnRange('>=1.0.0 <=2.0.0')).toBe('>2.0.0');
  });

  it('returns null for unparseable ranges', () => {
    expect(safeVersionFromVulnRange('*')).toBeNull();
    expect(safeVersionFromVulnRange('')).toBeNull();
    expect(safeVersionFromVulnRange(undefined as unknown as string)).toBeNull();
  });
});

describe('getGhsaId', () => {
  it('extracts GHSA id from array', () => {
    expect(getGhsaId(['CVE-2024-1234', 'GHSA-abcd-efgh-1234'])).toBe('GHSA-abcd-efgh-1234');
  });

  it('returns null when no GHSA id present', () => {
    expect(getGhsaId(['CVE-2024-1234'])).toBeNull();
    expect(getGhsaId([])).toBeNull();
  });
});

describe('collectHighFindings', () => {
  it('collects only high/critical findings', () => {
    const auditResult = {
      vulnerabilities: {
        'bad-pkg': {
          via: [{ title: 'XSS', severity: 'high', url: 'https://ghsa/GHSA-1234-5678-abcd', source: 'GHSA-1234-5678-abcd' }],
          range: '<2.0.0',
          fixAvailable: true,
        },
        'ok-pkg': {
          via: [{ title: 'Low issue', severity: 'low', url: 'https://example.com' }],
          range: '<1.0.0',
          fixAvailable: true,
        },
      },
    };
    const findings = collectHighFindings(auditResult, {}, '.');
    expect(findings).toHaveLength(1);
    expect(findings[0].package).toBe('bad-pkg');
    expect(findings[0].severity).toBe('high');
  });

  it('returns empty for no vulnerabilities', () => {
    expect(collectHighFindings({}, {}, '.')).toEqual([]);
    expect(collectHighFindings({ vulnerabilities: {} }, {}, '.')).toEqual([]);
  });
});

describe('groupFindingsByVuln', () => {
  it('groups findings by GHSA id', () => {
    const findings = [
      { dir: '.', package: 'pkg-a', severity: 'high', range: '<2.0.0', advisoryIds: ['GHSA-aaaa-bbbb-cccc'], advisory: { title: 'XSS' } },
      { dir: '.', package: 'pkg-b', severity: 'high', range: '<3.0.0', advisoryIds: ['GHSA-aaaa-bbbb-cccc'], advisory: { title: 'XSS' } },
      { dir: '.', package: 'pkg-c', severity: 'critical', range: '<1.0.0', advisoryIds: ['GHSA-dddd-eeee-ffff'], advisory: { title: 'RCE' } },
    ] as any;
    const groups = groupFindingsByVuln(findings);
    expect(groups).toHaveLength(2);
    expect(groups[0].packages).toHaveLength(2);
    expect(groups[1].packages).toHaveLength(1);
  });
});

describe('packageNameFromOverrideKey', () => {
  it('extracts package name from override key', () => {
    expect(packageNameFromOverrideKey('brace-expansion@<2.0.3')).toBe('brace-expansion');
    expect(packageNameFromOverrideKey('picomatch@<=4.0.1')).toBe('picomatch');
    expect(packageNameFromOverrideKey('@scope/pkg@<1.0.0')).toBe('@scope/pkg');
  });

  it('handles scoped packages with nested version pin', () => {
    expect(packageNameFromOverrideKey('@scope/pkg@>=1.0.0 <2.0.0')).toBe('@scope/pkg');
  });

  it('returns the key unchanged when there is no version suffix', () => {
    expect(packageNameFromOverrideKey('some-pkg')).toBe('some-pkg');
    expect(packageNameFromOverrideKey('@scope/pkg')).toBe('@scope/pkg');
  });
});

describe('cleanupStaleOverrides', () => {
  // cleanupStaleOverrides requires fs/process mocking (runAudit, installDeps, readFileSync, writeFileSync).
  // Core logic delegates to packageNameFromOverrideKey (tested above) and runAudit.
  // Integration coverage comes from the full pipeline test in bamboo.poller.service.
  it.todo('full unit test requires fs/exec mocking');
});
