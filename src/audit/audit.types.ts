export interface IAuditAdvisory {
  source?: string;
  url?: string;
  title?: string;
  severity?: string;
  cwe?: string[];
  range?: string;
}

export interface IAuditVulnerability {
  via: (IAuditAdvisory | string)[];
  range?: string;
  fixAvailable?: boolean | { name: string; version?: string; isSemVerMajor?: boolean };
}

export interface IAuditResult {
  vulnerabilities?: Record<string, IAuditVulnerability>;
}

export interface IAuditFinding {
  dir: string;
  package: string;
  severity: string;
  range?: string;
  fixAvailable?: boolean | { name: string; version?: string; isSemVerMajor?: boolean };
  advisoryIds: string[];
  advisory: IAuditAdvisory;
}

export interface IAuditVulnGroup {
  ghsaId: string | null;
  title: string;
  cwe: string;
  url: string;
  packages: {
    dir: string;
    package: string;
    severity: string;
    range?: string;
    fixAvailable?: boolean | { name: string; version?: string; isSemVerMajor?: boolean };
    advisoryIds: string[];
  }[];
}

export type FixStrategy = 'override' | 'upgrade' | 'upgrade-parent' | 'cannot-fix';

export interface IFixProposal {
  vulnGroup: IAuditVulnGroup;
  strategy: FixStrategy;
  overrideKey?: string;
  overrideVersion?: string;
  upgradePackage?: string;
  upgradeVersion?: string;
  isSemVerMajor?: boolean;
  currentVersion?: string;
  dir: string;
}

export interface IDeduplicatedAuditSummary {
  overrides: Map<string, string>;
  upgrades: Map<string, string>;
  upgradeParents: Map<string, { version: string; isMajor: boolean }>;
  removedOverrides: string[];
  ghsasFixed: Set<string>;
  ghsasUnfixable: Set<string>;
}

export function deduplicateProposals(proposals: IFixProposal[]): IDeduplicatedAuditSummary {
  const overrides = new Map<string, string>();
  const upgrades = new Map<string, string>();
  const upgradeParents = new Map<string, { version: string; isMajor: boolean }>();
  const ghsasFixed = new Set<string>();
  const ghsasUnfixable = new Set<string>();

  for (const p of proposals) {
    const ghsa = p.vulnGroup.ghsaId ?? p.vulnGroup.title;
    if (p.strategy === 'override' && p.overrideKey && p.overrideVersion) {
      overrides.set(p.overrideKey, p.overrideVersion);
      ghsasFixed.add(ghsa);
    } else if (p.strategy === 'upgrade' && p.upgradePackage) {
      upgrades.set(p.upgradePackage, p.upgradeVersion ?? 'latest');
      ghsasFixed.add(ghsa);
    } else if (p.strategy === 'upgrade-parent' && p.upgradePackage) {
      upgradeParents.set(p.upgradePackage, {
        version: p.upgradeVersion ?? 'latest',
        isMajor: !!p.isSemVerMajor,
      });
      ghsasFixed.add(ghsa);
    } else {
      ghsasUnfixable.add(ghsa);
    }
  }

  return { overrides, upgrades, upgradeParents, removedOverrides: [], ghsasFixed, ghsasUnfixable };
}

export function safeVersionFromVulnRange(range: string | undefined | null): string | null {
  if (!range) return null;
  // Extract the upper bound from the vulnerable range.
  // Anything above the upper bound is safe.
  //   "<1.55.1"            → "1.55.1"    (exact safe version)
  //   "<=10.3.1"           → ">10.3.1"   (npm range: first version above)
  //   ">=4.2.0 <4.2.5"     → "4.2.5"     (compound range: upper bound)
  //   ">=4.2.0 <=4.2.4"    → ">4.2.4"

  // Try strict upper bound: <X (not <=)
  const lt = range.match(/<([^=]\S*)/);
  if (lt) return lt[1];

  // Try inclusive upper bound: <=X
  const lte = range.match(/<=(\S+)/);
  if (lte) return `>${lte[1]}`;

  return null;
}
