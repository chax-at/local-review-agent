import { execFileSync, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IAuditResult, IAuditAdvisory, IAuditFinding, IAuditVulnGroup, IFixProposal } from './audit.types';
import { safeVersionFromVulnRange } from './audit.types';
import type { NpmRegistryClient } from './npm-registry.client';
export { safeVersionFromVulnRange } from './audit.types';

const HIGH_OR_WORSE = ['high', 'critical'];

/**
 * Deduplicate upgrade specs: if the same package appears multiple times
 * (e.g. from different vulnerability groups), keep only the highest version.
 * Returns array of `pkg@version` strings.
 */
function deduplicateUpgradeSpecs(proposals: IFixProposal[]): string[] {
  const byPkg = new Map<string, string>();
  for (const p of proposals) {
    if (!p.upgradePackage) continue;
    const version = p.upgradeVersion ?? 'latest';
    const existing = byPkg.get(p.upgradePackage);
    if (!existing || version === 'latest' || (existing !== 'latest' && compareVersions(version, existing) > 0)) {
      byPkg.set(p.upgradePackage, version);
    }
  }
  return [...byPkg.entries()].map(([pkg, ver]) => `${pkg}@${ver}`);
}

/** Compare two semver strings. Returns -1, 0, or 1. Only handles X.Y.Z (no pre-release). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}

/**
 * npm install can change the "name" field in package-lock.json when run in a temp dir.
 * Preserve the original name to avoid bogus diffs.
 */
export function preserveLockfileName(dir: string): void {
  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) return;

  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    const expectedName = pkg.name;
    if (!expectedName) return;

    let changed = false;

    // Top-level "name"
    if (lock.name !== expectedName) {
      lock.name = expectedName;
      changed = true;
    }

    // lockfileVersion 3: packages[""].name
    if (lock.packages?.['']?.name !== expectedName) {
      if (lock.packages?.['']) {
        lock.packages[''].name = expectedName;
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');
    }
  } catch {
    // Non-fatal — worst case the PR has a name diff
  }
}

// --- Pure functions (exported for testing) ---

export function getGhsaId(advisoryIds: string[]): string | null {
  return advisoryIds.find((id) => id && /^GHSA-[a-z0-9-]+$/i.test(id)) ?? null;
}

export function getAdvisoryIdsFromObj(adv: IAuditAdvisory): string[] {
  const ids: string[] = [];
  if (adv.source != null) ids.push(String(adv.source));
  if (adv.url) ids.push(adv.url);
  const ghsa = (adv.url ?? '').match(/GHSA-[a-z0-9-]+/i);
  if (ghsa) ids.push(ghsa[0]);
  return [...new Set(ids)];
}

export function getAllAdvisoryDetails(
  vulns: Record<string, { via: (IAuditAdvisory | string)[] }>,
  pkgName: string,
  visited = new Set<string>(),
): IAuditAdvisory[] {
  const v = vulns[pkgName];
  if (visited.has(pkgName)) return [];
  visited.add(pkgName);
  const out: IAuditAdvisory[] = [];
  for (const x of v.via) {
    if (typeof x === 'object' && (x.title != null || x.url)) out.push(x);
  }
  for (const x of v.via) {
    if (typeof x === 'string') out.push(...getAllAdvisoryDetails(vulns, x, visited));
  }
  return out;
}

export function collectHighFindings(
  auditResult: IAuditResult,
  _nsprc: Record<string, unknown>,
  dir: string,
): IAuditFinding[] {
  const list: IAuditFinding[] = [];
  const vulns = auditResult.vulnerabilities ?? {};
  for (const [pkg, v] of Object.entries(vulns)) {
    const allAdvisories = getAllAdvisoryDetails(vulns as Record<string, { via: (IAuditAdvisory | string)[] }>, pkg);
    for (const adv of allAdvisories) {
      const sev = (adv.severity ?? '').toLowerCase();
      if (!HIGH_OR_WORSE.includes(sev)) continue;
      const advisoryIds = [...new Set(getAdvisoryIdsFromObj(adv))];
      list.push({
        dir,
        package: pkg,
        severity: sev,
        range: v.range,
        fixAvailable: v.fixAvailable,
        advisoryIds,
        advisory: adv,
      });
    }
  }
  return list;
}

export function groupFindingsByVuln(findings: IAuditFinding[]): IAuditVulnGroup[] {
  const byKey = new Map<string, IAuditVulnGroup>();
  for (const f of findings) {
    const key = getGhsaId(f.advisoryIds) ?? f.advisoryIds[0];
    if (!byKey.has(key)) {
      byKey.set(key, {
        ghsaId: getGhsaId(f.advisoryIds),
        title: f.advisory.title ?? '-',
        cwe: (f.advisory.cwe ?? []).join(', ') || '-',
        url: f.advisory.url ?? '',
        packages: [],
      });
    }
    byKey.get(key)!.packages.push({
      dir: f.dir,
      package: f.package,
      severity: f.severity,
      range: f.range,
      fixAvailable: f.fixAvailable,
      advisoryIds: f.advisoryIds,
    });
  }
  return [...byKey.values()];
}

// --- I/O functions ---

export function loadNsprc(dir: string): Record<string, unknown> {
  const p = join(dir, '.nsprc');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeNsprc(dir: string, obj: Record<string, unknown>): void {
  writeFileSync(join(dir, '.nsprc'), `${JSON.stringify(obj, null, 2)}\n`, 'utf-8');
}

export function addOverrideToPackageJson(dir: string, overrideKey: string, overrideValue: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const overrides = pkg.overrides ?? {};
  if (overrides[overrideKey] === overrideValue) return false;
  pkg.overrides = { ...overrides, [overrideKey]: overrideValue };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  return true;
}

export function isDirectDependency(dir: string, packageName: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return !!(pkg.dependencies?.[packageName] || pkg.devDependencies?.[packageName]);
}

export function packageNameFromOverrideKey(overrideKey: string): string {
  if (overrideKey.startsWith('@')) {
    const afterScope = overrideKey.indexOf('/', 1);
    if (afterScope !== -1) {
      const atAfterSlash = overrideKey.indexOf('@', afterScope + 1);
      return atAfterSlash !== -1 ? overrideKey.slice(0, atAfterSlash) : overrideKey;
    }
  }
  return overrideKey.replace(/@[^@/]*$/, '');
}

// --- Audit orchestration ---

/**
 * AI review is explicitly excluded from audit fixes to prevent
 * prompt injection from malicious packages. All analysis and fix
 * application is purely programmatic.
 */
export class AuditService {
  constructor(private readonly registry?: NpmRegistryClient) {}

  public runAudit(cwd: string): IAuditResult | null {
    try {
      const stdout = (() => {
        try {
          return execSync('npm audit --json', {
            cwd,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (e: unknown) {
          return (e as { stdout?: string }).stdout ?? '';
        }
      })();
      return JSON.parse(stdout);
    } catch {
      LogSink.error(`Failed to parse npm audit output in ${cwd}`, TraceTags.AUDIT);
      return null;
    }
  }

  /**
   * Run npm install in multiple dirs — single Docker container if dockerImage set.
   * Returns list of dirs that failed.
   */
  private installDeps(repoDir: string, dirs: string[], dockerImage?: string): string[] {
    if (dirs.length === 0) return [];
    const failedDirs: string[] = [];

    if (dockerImage) {
      // Single Docker container for all dirs — capture per-dir success/failure + last 5 lines of error
      const script = dirs
        .map((dir) => {
          const workdir = dir === '.' ? '/repo' : `/repo/${dir}`;
          return [
            `echo "=== ${dir} ==="`,
            `cd ${workdir} 2>/dev/null || { echo "FAILED:${dir}:directory not found"; exit 0; }`,
            `if npm install 2>&1; then`,
            `  echo "OK:${dir}"`,
            `else`,
            `  echo "FAILED:${dir}:$(npm install 2>&1 | tail -5 | tr '\\n' ' ')"`,
            `fi`,
          ].join('\n');
        })
        .join('\n');

      LogSink.debug(
        `Running npm install via Docker (${dockerImage}) for ${dirs.length} dir(s) in one container`,
        TraceTags.AUDIT,
      );
      try {
        // Run as host user so created files are deletable without root
        const uid = process.getuid?.() ?? 1000;
        const gid = process.getgid?.() ?? 1000;
        const args = [
          'run',
          '--rm',
          '--user',
          `${uid}:${gid}`,
          '-v',
          `${repoDir}:/repo`,
          dockerImage,
          'sh',
          '-c',
          script,
        ];
        const output = execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe', timeout: 300000 });
        for (const line of output.split('\n')) {
          const failMatch = line.match(/^FAILED:([^:]+):(.*)$/);
          if (failMatch) {
            failedDirs.push(failMatch[1]);
            LogSink.error(`npm install failed in ${failMatch[1]}: ${failMatch[2].trim()}`, TraceTags.AUDIT);
          }
        }
      } catch (err: unknown) {
        const stderr = ((err as { stderr?: Buffer | string }).stderr ?? '').toString().slice(-500);
        const stdout = ((err as { stdout?: Buffer | string }).stdout ?? '').toString().slice(-500);
        LogSink.error(`Docker npm install container failed`, TraceTags.AUDIT);
        if (stderr) LogSink.debug(`Docker stderr: ${stderr}`, TraceTags.AUDIT);
        if (stdout) LogSink.debug(`Docker stdout: ${stdout}`, TraceTags.AUDIT);
        return dirs; // All failed
      }
    } else {
      for (const dir of dirs) {
        const fullDir = join(repoDir, dir);
        try {
          LogSink.debug(`Running npm install in ${fullDir}`, TraceTags.AUDIT);
          execSync('npm install', { cwd: fullDir, stdio: 'pipe', timeout: 120000 });
        } catch (err: unknown) {
          const stderr = ((err as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().slice(-500);
          LogSink.error(`npm install failed in ${dir}`, TraceTags.AUDIT);
          if (stderr) LogSink.debug(`npm install stderr: ${stderr}`, TraceTags.AUDIT);
          failedDirs.push(dir);
        }
      }
    }

    if (failedDirs.length > 0) {
      LogSink.warn(`npm install failed in: ${failedDirs.join(', ')}`, TraceTags.AUDIT);
    }
    return failedDirs;
  }

  public async analyzeAll(
    repoDir: string,
    packageDirs: string[],
    dockerImage?: string,
  ): Promise<{ vulnGroups: IAuditVulnGroup[]; proposals: IFixProposal[] }> {
    const allFindings: IAuditFinding[] = [];

    // Filter to dirs that have a package.json
    const validDirs = packageDirs.filter((dir) => {
      if (!existsSync(join(repoDir, dir, 'package.json'))) {
        LogSink.warn(`No package.json in ${join(repoDir, dir)}, skipping`, TraceTags.AUDIT);
        return false;
      }
      return true;
    });

    // Install deps in one Docker container (or locally)
    LogSink.debug(`Analyzing ${validDirs.length} package dir(s) in ${repoDir}`, TraceTags.AUDIT);
    const installFailed = this.installDeps(repoDir, validDirs, dockerImage);

    // npm install can corrupt lockfile "name" when run in temp dirs — restore original
    for (const dir of validDirs) {
      if (!installFailed.includes(dir)) preserveLockfileName(join(repoDir, dir));
    }

    for (const dir of validDirs) {
      if (installFailed.includes(dir)) continue;
      const fullDir = join(repoDir, dir);

      const auditResult = this.runAudit(fullDir);
      if (!auditResult) continue;

      const nsprc = loadNsprc(fullDir);
      const findings = collectHighFindings(auditResult, nsprc, dir);
      LogSink.debug(`${dir}: ${findings.length} high/critical findings`, TraceTags.AUDIT);
      allFindings.push(...findings);
    }

    const vulnGroups = groupFindingsByVuln(allFindings);
    const proposals = await this.buildProposals(vulnGroups, repoDir);
    LogSink.debug(
      `Audit summary: ${allFindings.length} findings, ${vulnGroups.length} groups, ${proposals.length} proposals`,
      TraceTags.AUDIT,
    );
    return { vulnGroups, proposals };
  }

  private getInstalledVersion(dir: string, packageName: string): string | undefined {
    try {
      const lockPath = join(dir, 'package-lock.json');
      if (!existsSync(lockPath)) return undefined;
      const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
      return lock.packages?.[`node_modules/${packageName}`]?.version;
    } catch {
      return undefined;
    }
  }

  private async buildProposals(vulnGroups: IAuditVulnGroup[], repoDir: string): Promise<IFixProposal[]> {
    const proposals: IFixProposal[] = [];

    for (const group of vulnGroups) {
      for (const pkg of group.packages) {
        const fullDir = join(repoDir, pkg.dir);
        const isDirect = isDirectDependency(fullDir, pkg.package);
        const fa = pkg.fixAvailable;

        // 1. Direct dependency with semver-compatible fix → upgrade
        if (isDirect && fa && typeof fa === 'object' && fa.name && !fa.isSemVerMajor) {
          const currentVersion = this.getInstalledVersion(fullDir, fa.name);
          proposals.push({
            vulnGroup: group,
            strategy: 'upgrade',
            upgradePackage: fa.name,
            upgradeVersion: fa.version,
            currentVersion,
            dir: pkg.dir,
          });
          continue;
        }

        // 2. Transitive dependency → try override (resolve exact version via registry)
        if (!isDirect) {
          const rangeSafeVersion = safeVersionFromVulnRange(pkg.range);
          if (rangeSafeVersion) {
            let exactVersion = rangeSafeVersion;
            if (this.registry) {
              const resolved = await this.registry.getNextSafeVersion(pkg.package, pkg.range ?? '');
              if (resolved) exactVersion = resolved;
            }
            const currentVersion = this.getInstalledVersion(fullDir, pkg.package);
            proposals.push({
              vulnGroup: group,
              strategy: 'override',
              overrideKey: `${pkg.package}@${pkg.range}`,
              overrideVersion: exactVersion,
              currentVersion,
              dir: pkg.dir,
            });
            continue;
          }
        }

        // 3. fixAvailable names a direct dep (even major) → upgrade-parent
        if (fa && typeof fa === 'object' && fa.name && isDirectDependency(fullDir, fa.name)) {
          const currentVersion = this.getInstalledVersion(fullDir, fa.name);
          proposals.push({
            vulnGroup: group,
            strategy: 'upgrade-parent',
            upgradePackage: fa.name,
            upgradeVersion: fa.version,
            isSemVerMajor: !!fa.isSemVerMajor,
            currentVersion,
            dir: pkg.dir,
          });
          continue;
        }

        // 4. Cannot auto-fix
        proposals.push({
          vulnGroup: group,
          strategy: 'cannot-fix',
          dir: pkg.dir,
        });
      }
    }

    return proposals;
  }

  public applyFixBatch(
    repoDir: string,
    proposals: IFixProposal[],
    dockerImage?: string,
  ): { applied: number; failedDirs: string[] } {
    // Group proposals by dir
    const byDir = new Map<string, IFixProposal[]>();
    for (const p of proposals) {
      if (p.strategy === 'cannot-fix') continue;
      if (!byDir.has(p.dir)) byDir.set(p.dir, []);
      byDir.get(p.dir)!.push(p);
    }

    // Phase 1: Write all overrides to package.json files (no npm install yet)
    const modifiedDirs: string[] = [];
    const originalPkgs = new Map<string, string>(); // dir → original package.json content

    for (const [dir, dirProposals] of byDir) {
      const fullDir = join(repoDir, dir);
      const pkgPath = join(fullDir, 'package.json');
      if (existsSync(pkgPath)) originalPkgs.set(dir, readFileSync(pkgPath, 'utf-8'));

      let modified = false;
      for (const p of dirProposals) {
        if (p.strategy === 'override' && p.overrideKey && p.overrideVersion) {
          if (addOverrideToPackageJson(fullDir, p.overrideKey, p.overrideVersion)) {
            modified = true;
          }
        }
      }

      // Phase 1b: Batch all upgrades for this dir (deduped, fallback to one-at-a-time)
      const upgradeProposals = dirProposals.filter(
        (p) => (p.strategy === 'upgrade' || p.strategy === 'upgrade-parent') && p.upgradePackage,
      );
      const upgradeSpecs = deduplicateUpgradeSpecs(upgradeProposals);
      if (upgradeSpecs.length > 0) {
        let batchOk = false;
        if (upgradeSpecs.length > 1) {
          try {
            LogSink.debug(`Running npm install ${upgradeSpecs.join(' ')} in ${fullDir}`, TraceTags.AUDIT);
            execFileSync('npm', ['install', ...upgradeSpecs], { cwd: fullDir, stdio: 'pipe', timeout: 120000 });
            modified = true;
            batchOk = true;
          } catch {
            LogSink.warn(`Batched npm install failed in ${fullDir}, falling back to one-at-a-time`, TraceTags.AUDIT);
          }
        }
        if (!batchOk) {
          for (const spec of upgradeSpecs) {
            try {
              LogSink.debug(`Running npm install ${spec} in ${fullDir}`, TraceTags.AUDIT);
              execFileSync('npm', ['install', spec], { cwd: fullDir, stdio: 'pipe', timeout: 120000 });
              modified = true;
            } catch (err: unknown) {
              const stderr = ((err as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().slice(-500);
              LogSink.error(`npm install ${spec} failed in ${fullDir}`, TraceTags.AUDIT);
              if (stderr) LogSink.debug(`npm install stderr: ${stderr}`, TraceTags.AUDIT);
            }
          }
        }
      }

      if (modified) modifiedDirs.push(dir);
    }

    if (modifiedDirs.length === 0) return { applied: 0, failedDirs: [] };

    // Phase 2: Run npm install for all modified dirs (single Docker container)
    const installFailed = this.installDeps(repoDir, modifiedDirs, dockerImage);

    // npm install can corrupt lockfile "name" — restore original
    for (const dir of modifiedDirs) {
      if (!installFailed.includes(dir)) preserveLockfileName(join(repoDir, dir));
    }

    // Revert package.json for dirs that failed
    for (const dir of installFailed) {
      const original = originalPkgs.get(dir);
      if (original) writeFileSync(join(repoDir, dir, 'package.json'), original, 'utf-8');
    }

    const applied = modifiedDirs.filter((d) => !installFailed.includes(d)).length;
    return { applied, failedDirs: installFailed };
  }

  public applyFix(repoDir: string, proposal: IFixProposal): boolean {
    const fullDir = join(repoDir, proposal.dir);

    if (proposal.strategy === 'override' && proposal.overrideKey && proposal.overrideVersion) {
      // Save original package.json so we can revert if npm install fails
      const pkgPath = join(fullDir, 'package.json');
      const originalPkg = existsSync(pkgPath) ? readFileSync(pkgPath, 'utf-8') : null;
      const modified = addOverrideToPackageJson(fullDir, proposal.overrideKey, proposal.overrideVersion);
      if (!modified) return false;
      try {
        LogSink.debug(
          `Running npm install in ${fullDir} after override ${proposal.overrideKey}@${proposal.overrideVersion}`,
          TraceTags.AUDIT,
        );
        execSync('npm install', { cwd: fullDir, stdio: 'pipe', timeout: 120000 });
        return true;
      } catch (err: unknown) {
        const stderr = ((err as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().slice(-500);
        const stdout = ((err as { stdout?: Buffer }).stdout ?? Buffer.alloc(0)).toString().slice(-500);
        LogSink.error(`npm install after override failed in ${fullDir}, reverting package.json`, TraceTags.AUDIT);
        if (stderr) LogSink.debug(`npm install stderr: ${stderr}`, TraceTags.AUDIT);
        if (stdout) LogSink.debug(`npm install stdout: ${stdout}`, TraceTags.AUDIT);
        if (originalPkg) writeFileSync(pkgPath, originalPkg, 'utf-8');
        return false;
      }
    }

    if ((proposal.strategy === 'upgrade' || proposal.strategy === 'upgrade-parent') && proposal.upgradePackage) {
      return this.applyUpgrades(repoDir, [proposal]);
    }

    return false;
  }

  /**
   * Apply multiple upgrade/upgrade-parent proposals for the same dir in a single
   * `npm install` command. Packages with peer-dep relationships (e.g. NestJS core+testing)
   * must be upgraded together to avoid ERESOLVE conflicts.
   *
   * Deduplicates specs (same package → highest version). If batched install fails
   * (e.g. incompatible cross-group versions from npm audit), falls back to one-at-a-time.
   */
  public applyUpgrades(repoDir: string, proposals: IFixProposal[]): boolean {
    if (proposals.length === 0) return false;
    const { dir } = proposals[0];
    const fullDir = join(repoDir, dir);
    const specs = deduplicateUpgradeSpecs(
      proposals.filter((p) => (p.strategy === 'upgrade' || p.strategy === 'upgrade-parent') && p.upgradePackage),
    );
    if (specs.length === 0) return false;

    // Try batched install first
    if (specs.length > 1) {
      try {
        LogSink.debug(`Running npm install ${specs.join(' ')} in ${fullDir}`, TraceTags.AUDIT);
        execFileSync('npm', ['install', ...specs], { cwd: fullDir, stdio: 'pipe', timeout: 120000 });
        return true;
      } catch {
        LogSink.warn(`Batched npm install failed in ${fullDir}, falling back to one-at-a-time`, TraceTags.AUDIT);
      }
    }

    // Fallback: install one at a time (best-effort)
    let anySucceeded = false;
    for (const spec of specs) {
      try {
        LogSink.debug(`Running npm install ${spec} in ${fullDir}`, TraceTags.AUDIT);
        execFileSync('npm', ['install', spec], { cwd: fullDir, stdio: 'pipe', timeout: 120000 });
        anySucceeded = true;
      } catch (err: unknown) {
        const stderr = ((err as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().slice(-500);
        LogSink.error(`npm install ${spec} failed in ${fullDir}`, TraceTags.AUDIT);
        if (stderr) LogSink.debug(`npm install stderr: ${stderr}`, TraceTags.AUDIT);
      }
    }
    return anySucceeded;
  }

  public ignore(repoDir: string, dir: string, ghsaId: string, reason: string): void {
    const fullDir = join(repoDir, dir);
    const nsprc = loadNsprc(fullDir);
    const expiryMs = new Date();
    expiryMs.setMonth(expiryMs.getMonth() + 1);
    nsprc[ghsaId] = { active: true, expiry: expiryMs.getTime(), notes: reason };
    writeNsprc(fullDir, nsprc);
  }

  /**
   * Verify audit passes. Tries `npm run audit` first (project-specific config),
   * falls back to `npm audit --audit-level=high` if no audit script exists.
   */
  public verifyAudit(cwd: string): { passes: boolean; output: string } {
    try {
      const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf-8'));
      const cmd = pkg.scripts?.audit ? 'npm run audit' : 'npm audit --audit-level=high';
      LogSink.debug(`Verifying audit in ${cwd}: ${cmd}`, TraceTags.AUDIT);
      execSync(cmd, { cwd, stdio: 'pipe', timeout: 60000 });
      return { passes: true, output: '' };
    } catch (err: unknown) {
      const stdout = ((err as { stdout?: Buffer }).stdout ?? Buffer.alloc(0)).toString().slice(-2000);
      const stderr = ((err as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().slice(-500);
      const output = `${stdout}\n${stderr}`.trim();
      return { passes: false, output };
    }
  }

  public cleanupStaleOverrides(repoDir: string, dirs: string[], dockerImage?: string): string[] {
    const removed: string[] = [];

    for (const dir of dirs) {
      const fullDir = join(repoDir, dir);
      const pkgPath = join(fullDir, 'package.json');
      if (!existsSync(pkgPath)) continue;

      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const { overrides } = pkg;
      if (!overrides || Object.keys(overrides).length === 0) continue;

      const auditResult = this.runAudit(fullDir);
      if (!auditResult) continue;

      const vulnPkgs = new Set(Object.keys(auditResult.vulnerabilities ?? {}));
      const toRemove: string[] = [];

      for (const overrideKey of Object.keys(overrides)) {
        const pkgName = packageNameFromOverrideKey(overrideKey);
        if (!vulnPkgs.has(pkgName)) {
          toRemove.push(overrideKey);
        }
      }

      if (toRemove.length === 0) continue;

      for (const key of toRemove) {
        delete pkg.overrides[key];
        removed.push(key);
      }

      if (Object.keys(pkg.overrides).length === 0) delete pkg.overrides;
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');

      const installFailed = this.installDeps(repoDir, [dir], dockerImage);
      if (installFailed.length > 0) {
        LogSink.warn(`npm install after override cleanup failed in ${dir}`, TraceTags.AUDIT);
      } else {
        preserveLockfileName(fullDir);
      }
    }

    return removed;
  }
}
