import { describe, it, expect } from 'vitest';
import { deduplicateProposals } from '../../src/audit/audit.types';
import type { IFixProposal, IAuditVulnGroup } from '../../src/audit/audit.types';

const makeGroup = (ghsaId: string): IAuditVulnGroup => ({
  ghsaId,
  title: `Vuln ${ghsaId}`,
  cwe: 'CWE-1234',
  url: `https://github.com/advisories/${ghsaId}`,
  packages: [],
});

describe('deduplicateProposals', () => {
  it('handles override, upgrade, and upgrade-parent strategies', () => {
    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-1111'), strategy: 'override', overrideKey: 'pkg-a@<2.0.0', overrideVersion: '2.0.0', dir: '.' },
      { vulnGroup: makeGroup('GHSA-2222'), strategy: 'upgrade', upgradePackage: 'pkg-b', upgradeVersion: '3.0.0', dir: '.' },
      { vulnGroup: makeGroup('GHSA-3333'), strategy: 'upgrade-parent', upgradePackage: 'pkg-c', upgradeVersion: '4.0.0', isSemVerMajor: true, dir: '.' },
      { vulnGroup: makeGroup('GHSA-4444'), strategy: 'cannot-fix', dir: '.' },
    ];
    const result = deduplicateProposals(proposals);

    expect(result.overrides.get('pkg-a@<2.0.0')).toBe('2.0.0');
    expect(result.upgrades.get('pkg-b')).toBe('3.0.0');
    expect(result.upgradeParents.get('pkg-c')).toEqual({ version: '4.0.0', isMajor: true });
    expect(result.ghsasFixed.size).toBe(3);
    expect(result.ghsasUnfixable).toContain('GHSA-4444');
    expect(result.removedOverrides).toEqual([]);
  });

  it('does not put upgrade-parent into ghsasUnfixable', () => {
    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-5555'), strategy: 'upgrade-parent', upgradePackage: 'nodemon', upgradeVersion: '4.0.0', isSemVerMajor: true, dir: '.' },
    ];
    const result = deduplicateProposals(proposals);
    expect(result.ghsasUnfixable.size).toBe(0);
    expect(result.ghsasFixed.has('GHSA-5555')).toBe(true);
  });
});
