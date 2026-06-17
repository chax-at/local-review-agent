import { describe, it, expect } from 'vitest';
import { buildAuditPrDescription } from '../../src/bamboo/bamboo.poller.service';
import type { IFixProposal, IAuditVulnGroup } from '../../src/audit/audit.types';
import type { IChangelogSummary } from '../../src/audit/changelog.service';

const makeGroup = (ghsaId: string): IAuditVulnGroup => ({
  ghsaId, title: `Vuln ${ghsaId}`, cwe: 'CWE-1234', url: '', packages: [],
});

describe('buildAuditPrDescription', () => {
  it('includes override, upgrade, and upgrade-parent changes', () => {
    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-1111'), strategy: 'override', overrideKey: 'pkg-a@<2.0.0', overrideVersion: '2.0.0', dir: '.' },
      { vulnGroup: makeGroup('GHSA-2222'), strategy: 'upgrade-parent', upgradePackage: 'nodemon', upgradeVersion: '4.0.0', isSemVerMajor: true, dir: '.' },
    ];
    const result = buildAuditPrDescription(proposals, '2026-03-28T10-00');
    expect(result).toContain('**Changes (2):**');
    expect(result).toContain('override `pkg-a@<2.0.0`');
    expect(result).toContain('upgrade-parent `nodemon`');
    expect(result).toContain('MAJOR - potentially more dangerous');
  });

  it('includes removed stale overrides section', () => {
    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-1111'), strategy: 'override', overrideKey: 'pkg@<2.0.0', overrideVersion: '2.0.0', dir: '.' },
    ];
    const result = buildAuditPrDescription(proposals, '2026-03-28', [], [], ['old-override@<1.0.0']);
    expect(result).toContain('**Removed stale overrides (1):**');
    expect(result).toContain('`old-override@<1.0.0`');
  });

  it('includes changelog summaries with token counts and disclaimer', () => {
    const summaries: IChangelogSummary[] = [{
      packageName: 'picomatch', fromVersion: '2.3.1', toVersion: '4.0.2',
      compareUrl: 'https://github.com/micromatch/picomatch/compare/v2.3.1...v4.0.2',
      summary: '- Rewrote POSIX class handling\n- Dropped Node 10',
      tokens: { input: 1200, output: 85 },
    }];
    const result = buildAuditPrDescription([], '2026-03-28', [], summaries);
    expect(result).toContain('**picomatch** 2.3.1');
    expect(result).toContain('1,200 input / 85 output tokens');
    expect(result).toContain('may contain inaccuracies or reflect manipulated upstream content');
  });

  it('shows skip reason when summary is null', () => {
    const summaries: IChangelogSummary[] = [{
      packageName: 'pkg', fromVersion: '1.0.0', toVersion: '2.0.0',
      compareUrl: null, summary: null, skipReason: 'too-large', tokens: null,
    }];
    const result = buildAuditPrDescription([], '2026-03-28', [], summaries);
    expect(result).toContain('Summary skipped: too-large');
  });

  it('includes prompt injection disclaimer footer', () => {
    const result = buildAuditPrDescription([], '2026-03-28');
    expect(result).toContain('AI review is excluded from audit fix decisions');
  });
});
