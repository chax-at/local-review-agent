#!/usr/bin/env node
/**
 * Audit autofix: run audits (frontend, common, backend) in parallel,
 * show outdated (expired, still reported) .nsprc ignores and high-severity findings grouped by vulnerability.
 * No-longer-reported ignores are auto-removed. Outdated ones can be prolonged or removed.
 * Interactive: number = ignore vuln, [p] prolong outdated, [a] ignore all, [f] audit fix, [o] add override, [q] quit.
 * Only high/critical advisories are shown (filter by leaf advisory severity, not package severity).
 * Uses only Node built-ins.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execPromise = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PACKAGES = ['.'];
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const HIGH_OR_WORSE = ['high', 'critical'];
const GITHUB_ADVISORY_TIMEOUT_MS = 10000;

const summary = { ignored: [], removedStale: [], prolonged: [], auditFixRun: false, auditFixDirs: [], overridesAdded: [], upgraded: [] };

/** No-op for single-folder projects (no Nexus registry rewrite needed). */
function rewriteLockfilesRegistry() {}

function runAuditAsync(cwd) {
  const cwdPath = join(ROOT, cwd);
  return execPromise('npm audit --json', { cwd: cwdPath, maxBuffer: 10 * 1024 * 1024 })
    .then(({ stdout }) => JSON.parse(stdout))
    .catch((e) => {
      const raw = e.stdout || e.stderr || '';
      try {
        return JSON.parse(raw);
      } catch (_) {
        try {
          const firstLine = raw.trim().split('\n')[0];
          if (firstLine && firstLine.startsWith('{')) return JSON.parse(raw.trim());
        } catch (_2) {}
        return null;
      }
    });
}

function loadNsprc(cwd) {
  const p = join(ROOT, cwd, '.nsprc');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function parseExpiry(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function getOutdatedIgnores(nsprc) {
  const now = Date.now();
  const out = [];
  for (const [key, val] of Object.entries(nsprc)) {
    if (key === 'Note') continue;
    const expiry = typeof val === 'object' && val !== null ? parseExpiry(val.expiry) : null;
    if (expiry != null && expiry < now) out.push({ key, val });
  }
  return out;
}

/** GHSA ids that appear in this audit result (any severity). */
function getGhsaIdsInAudit(auditResult) {
  const set = new Set();
  const vulns = auditResult?.vulnerabilities || {};
  for (const pkg of Object.keys(vulns)) {
    const advisories = getAllAdvisoryDetails(vulns, pkg);
    for (const adv of advisories) {
      const ghsa = getGhsaId(getAdvisoryIdsFromObj(adv));
      if (ghsa) set.add(ghsa);
    }
  }
  return set;
}

/** .nsprc entries that are GHSA keys but no longer appear in the audit (vuln no longer reported). */
function getStaleIgnores(nsprc, ghsaIdsInAudit) {
  const out = [];
  for (const [key, val] of Object.entries(nsprc)) {
    if (key === 'Note') continue;
    if (!/^GHSA-[a-z0-9-]+$/i.test(key)) continue;
    if (ghsaIdsInAudit.has(key)) continue;
    out.push({ key, val });
  }
  return out;
}

function getGhsaId(advisoryIds) {
  return advisoryIds.find((id) => id && /^GHSA-[a-z0-9-]+$/i.test(id)) || null;
}

function getAdvisoryIdsFromObj(adv) {
  const ids = [];
  if (adv.source != null) ids.push(String(adv.source));
  if (adv.url) ids.push(adv.url);
  const ghsa = (adv.url || '').match(/GHSA-[a-z0-9-]+/i);
  if (ghsa) ids.push(ghsa[0]);
  return ids;
}

function isIgnored(advisoryIds, nsprc) {
  const now = Date.now();
  for (const id of advisoryIds) {
    const val = nsprc[id];
    if (val == null) continue;
    const expiry = typeof val === 'object' && val !== null ? parseExpiry(val.expiry) : null;
    const active = typeof val === 'object' && val !== null ? val.active !== false : true;
    if (!active) continue;
    if (expiry == null || expiry >= now) return true;
  }
  return false;
}

/** Collect all leaf advisory objects from the via chain (each has .severity). */
function getAllAdvisoryDetails(vulns, pkgName, visited = new Set()) {
  const v = vulns[pkgName];
  if (!v || visited.has(pkgName)) return [];
  visited.add(pkgName);
  const via = v.via || [];
  const out = [];
  for (const x of via) {
    if (typeof x === 'object' && x !== null && (x.title != null || x.url)) out.push(x);
  }
  for (const x of via) {
    if (typeof x === 'string') out.push(...getAllAdvisoryDetails(vulns, x, visited));
  }
  return out;
}

/** Only include findings where the leaf advisory's severity is high/critical. Includes both ignored and not. */
function collectHighFindings(auditResult, nsprc, dir) {
  const list = [];
  const vulns = auditResult?.vulnerabilities || {};
  for (const [pkg, v] of Object.entries(vulns)) {
    const allAdvisories = getAllAdvisoryDetails(vulns, pkg);
    for (const adv of allAdvisories) {
      const sev = (adv.severity || '').toLowerCase();
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

function groupFindingsByVuln(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = getGhsaId(f.advisoryIds) || f.advisoryIds[0] || `${f.dir}:${f.package}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        ghsaId: getGhsaId(f.advisoryIds),
        title: f.advisory?.title || '-',
        cwe: (f.advisory?.cwe || []).join(', ') || '-',
        url: f.advisory?.url || '',
        packages: [],
      });
    }
    byKey.get(key).packages.push({
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

function getIgnoreExpiryInfo(advisoryIds, nsprc) {
  const now = Date.now();
  for (const id of advisoryIds) {
    const val = nsprc[id];
    if (val == null) continue;
    const expiry = typeof val === 'object' && val !== null ? parseExpiry(val.expiry) : null;
    const active = typeof val === 'object' && val !== null ? val.active !== false : true;
    if (!active || expiry == null) continue;
    if (expiry >= now) return { expiryMs: expiry };
  }
  return null;
}

function formatIgnoreUntil(expiryMs) {
  const now = Date.now();
  const d = new Date(expiryMs);
  const dateStr = d.toISOString().slice(0, 10);
  if (expiryMs < now) return `expired ${dateStr}`;
  const days = Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000));
  return `until ${dateStr} (${days}d)`;
}

function truncate(s, maxLen) {
  if (!s || s.length <= maxLen) return s || '';
  return s.slice(0, maxLen - 1) + '…';
}

function asciiTable(headers, rows, colWidths = null) {
  const widths = colWidths || headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] || '').length)));
  const pad = (cell, w) => String(cell).slice(0, w).padEnd(w);
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const line = (arr) => '| ' + arr.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
  return [sep, line(headers), sep, ...rows.map((r) => line(r)), sep];
}

function ignoreFinding(nsprc, advisoryIds, notes, expiryMs) {
  const ghsaId = getGhsaId(advisoryIds);
  if (!ghsaId) return;
  nsprc[ghsaId] = { active: true, expiry: expiryMs, notes: notes || '' };
}

function writeNsprc(dir, obj) {
  writeFileSync(join(ROOT, dir, '.nsprc'), JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

/**
 * Add or update a single override in a package's package.json.
 * overrideKey: the override key (e.g. "multer@2.1.0" or "fast-xml-parser")
 * overrideValue: the version to override to (e.g. "2.1.1")
 * Returns true if file was modified.
 */
function addOverrideToPackageJson(dir, overrideKey, overrideValue) {
  if (!overrideKey || !overrideValue) return false;

  const pkgPath = join(ROOT, dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const overrides = pkg.overrides || {};
  if (overrides[overrideKey] === overrideValue) return false;
  pkg.overrides = { ...overrides, [overrideKey]: overrideValue };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  return true;
}

/**
 * Run npm install in dir so overrides take effect in lockfile.
 */
function runNpmInstall(dir) {
  execSync('npm install', { cwd: join(ROOT, dir), stdio: 'inherit' });
}

/**
 * Check whether a package is a direct dependency (dependencies or devDependencies) in a dir's package.json.
 */
function isDirectDependency(dir, packageName) {
  const pkgPath = join(ROOT, dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return !!(pkg.dependencies?.[packageName] || pkg.devDependencies?.[packageName]);
}

/**
 * Check whether a package exists anywhere in a dir's dependency tree (package-lock.json).
 */
function isInDependencyTree(dir, packageName) {
  const lockPath = join(ROOT, dir, 'package-lock.json');
  if (!existsSync(lockPath)) return false;
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    const packages = lock.packages || {};
    const suffix = `node_modules/${packageName}`;
    return Object.keys(packages).some((key) => key === suffix || key.endsWith(`/${suffix}`));
  } catch {
    return false;
  }
}

/**
 * Extract the bare package name from an override key (e.g. "multer@<2.1.1" → "multer").
 */
function packageNameFromOverrideKey(overrideKey) {
  return (overrideKey || '').replace(/@[^@/]*$/, '');
}

/**
 * Upgrade a specific package to a given version in dir by running npm install <pkg>@<version>.
 */
function runNpmInstallPackage(dir, packageName, version) {
  execSync(`npm install ${packageName}@${version}`, { cwd: join(ROOT, dir), stdio: 'inherit' });
}

function addMonthMs() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

async function fetchGitHubAdvisory(ghsaId) {
  try {
    const res = await fetch(`https://api.github.com/advisories/${ghsaId}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'audit-autofix-script',
      },
      signal: AbortSignal.timeout(GITHUB_ADVISORY_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    const data = await res.json();
    return {
      summary: data.summary || data.description || '',
      description: data.description || '',
      severity: data.severity,
      html_url: data.html_url,
    };
  } catch {
    return null;
  }
}

async function gather(state) {
  const results = await Promise.all(
    PACKAGES.map(async (dir) => {
      let nsprc = loadNsprc(dir);
      const auditResult = await runAuditAsync(dir);
      const ghsaInAudit = getGhsaIdsInAudit(auditResult);
      // Auto-remove stale (no longer in audit)
      const staleList = getStaleIgnores(nsprc, ghsaInAudit);
      if (staleList.length > 0) {
        nsprc = { ...nsprc };
        for (const { key } of staleList) delete nsprc[key];
        writeNsprc(dir, nsprc);
        summary.removedStale.push(...staleList.map(({ key }) => `${dir}: ${key}`));
      }
      // Outdated = expired but still reported (user can prolong or remove)
      const outdatedList = getOutdatedIgnores(nsprc)
        .filter(({ key }) => /^GHSA-[a-z0-9-]+$/i.test(key) && ghsaInAudit.has(key))
        .map(({ key, val }) => ({ dir, key, val }));
      const high = collectHighFindings(auditResult, nsprc, dir);
      return { dir, nsprc, outdatedList, auditResult, high };
    })
  );
  state.nsprc = {};
  state.auditResult = {};
  state.outdated = [];
  state.highFindings = [];
  for (const r of results) {
    state.nsprc[r.dir] = r.nsprc;
    state.auditResult[r.dir] = r.auditResult;
    state.outdated.push(...r.outdatedList);
    state.highFindings.push(...r.high);
  }
  state.actionableVulns = groupFindingsByVuln(state.highFindings.filter((f) => !isIgnored(f.advisoryIds, state.nsprc[f.dir])));
  state.ignoredVulns = groupFindingsByVuln(state.highFindings.filter((f) => isIgnored(f.advisoryIds, state.nsprc[f.dir])));
  return state;
}

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

/**
 * Read a line and return the first character (lowercase). Use for single-key choices;
 * we use line mode (Enter required) to avoid TTY/raw-mode issues on Windows.
 */
function askOneKey(rl, prompt, _allowedChars) {
  return ask(rl, prompt).then((line) => (line || '').trim().toLowerCase().slice(0, 1));
}

/**
 * Given a vulnerable range string (e.g. "<2.1.1" or "<=7.0.2"), returns the exact
 * minimum safe version suitable for use in package.json overrides (e.g. "2.1.1").
 * Returns a specific version (not a range) so overrides are pinned and safe.
 */
function safeVersionFromVulnRange(range) {
  if (!range) return null;
  const lt = range.match(/^<(\S+)$/);
  if (lt) return lt[1];
  const lte = range.match(/^<=(\d+)\.(\d+)\.(\d+)$/);
  if (lte) return `${lte[1]}.${lte[2]}.${parseInt(lte[3]) + 1}`;
  return null;
}

/**
 * Fetch full package metadata from npm registry (dist-tags + version publish times).
 */
async function fetchNpmPackageInfo(packageName) {
  try {
    const res = await fetch(`${NPM_REGISTRY}${encodeURIComponent(packageName)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { latestVersion: data['dist-tags']?.latest, time: data.time || {} };
  } catch {
    return null;
  }
}

async function main() {
  rewriteLockfilesRegistry();
  const state = { nsprc: {}, auditResult: {}, outdated: [], highFindings: [], actionableVulns: [], ignoredVulns: [] };
  await gather(state);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const DIM = '\x1b[2m';
  const RESET = '\x1b[22m';

  function formatFixAvailable(fa) {
    if (fa === true) return 'yes';
    if (fa && typeof fa === 'object' && fa.name) return `via ${fa.name}@${fa.version || '?'}${fa.isSemVerMajor ? ' (major)' : ''}`;
    return '-';
  }

  async function showAndLoop() {
    await gather(state);
    const { outdated, actionableVulns, ignoredVulns } = state;

    if (outdated.length === 0 && actionableVulns.length === 0) {
      console.log('\n--- Audit autofix summary ---');
      if (summary.ignored.length) console.log('Ignored (expiry +1 month):', summary.ignored.map((s) => '  ' + s).join('\n'));
      if (summary.removedStale.length) console.log('Auto-removed (no longer reported):', summary.removedStale.map((s) => '  ' + s).join('\n'));
      if (summary.prolonged.length) console.log('Prolonged:', summary.prolonged.map((s) => '  ' + s).join('\n'));
      if (summary.auditFixRun) console.log('Ran npm audit fix in:', summary.auditFixDirs.join(', '));
      if (summary.overridesAdded.length) console.log('Overrides added:', summary.overridesAdded.map((s) => '  ' + s).join('\n'));
      if (summary.upgraded.length) console.log('Upgraded:', summary.upgraded.map((s) => '  ' + s).join('\n'));
      const anyChanges =
        summary.ignored.length ||
        summary.removedStale.length ||
        summary.prolonged.length ||
        summary.auditFixRun ||
        summary.overridesAdded.length ||
        summary.upgraded.length;
      if (!anyChanges) console.log('No changes made; audits are clean.');
      rl.close();
      process.exit(0);
    }

    if (summary.removedStale.length > 0) {
      console.log('\nAuto-removed (no longer reported):', summary.removedStale.map((s) => '  ' + s).join('\n'));
    }

    console.log('\n========== Audit status ==========');
    if (outdated.length > 0) {
      console.log('\nOutdated (expired, still reported – prolong to extend):');
      outdated.forEach(({ dir, key }, i) => console.log(`  ${i + 1}. [${dir}] ${key}`));
    }

    if (actionableVulns.length > 0) {
      console.log('\nHigh severity (actionable):');
      actionableVulns.forEach((v, i) => {
        console.log(`  ${i + 1}. ${v.ghsaId || '-'}  ${v.title}`);
        if (v.url) console.log(`      ${v.url}`);
        console.log(`      CWE: ${v.cwe}`);
        const rows = v.packages.map((p) => [p.dir, truncate(p.package, 28), truncate(p.range || '-', 28), truncate(formatFixAvailable(p.fixAvailable), 24)]);
        asciiTable(['dir', 'package', 'vulnerable', 'fix'], rows, [8, 28, 28, 24]).forEach((l) => console.log('      ' + l));
      });
    }
    if (ignoredVulns.length > 0) {
      console.log(`\n${DIM}High severity (already ignored):${RESET}`);
      ignoredVulns.forEach((v) => {
        const info = v.packages[0] && getIgnoreExpiryInfo(v.packages[0].advisoryIds, state.nsprc[v.packages[0].dir]);
        const until = info ? formatIgnoreUntil(info.expiryMs) : '-';
        console.log(`${DIM}  - ${v.ghsaId || '-'}  ${v.title}  |  ${until}${RESET}`);
        const rows = v.packages.map((p) => [p.dir, truncate(p.package, 26), truncate(p.range || '-', 24)]);
        asciiTable(['dir', 'package', 'vulnerable'], rows, [8, 26, 24]).forEach((l) => console.log(DIM + '      ' + l + RESET));
      });
    }

    const optStr = [
      outdated.length ? '[p] Prolong an outdated ignore (extend by 1 month)' : '',
      actionableVulns.length
        ? `Type a number (${actionableVulns.length === 1 ? '1' : `1-${actionableVulns.length}`}) to view details, then (i)gnore, (o)verride, or (u)pgrade the package`
        : '',
      actionableVulns.length ? '[a] Ignore all' : '',
      actionableVulns.length ? '[o] Add package.json override for a vulnerability' : '',
      '[f] Run npm audit fix in affected folders',
      '[o] Add package to overrides (e.g. multer@2.1.0 → 2.1.1)',
      '[q] Quit without changes',
    ].filter(Boolean).join('\n');
    console.log('\nOptions:\n' + optStr);

    const singleKeyAllowed =
      actionableVulns.length < 10
        ? '123456789'.slice(0, actionableVulns.length) + (actionableVulns.length ? 'a' : '') + (outdated.length ? 'p' : '') + 'foq'
        : '';
    const line = singleKeyAllowed
      ? await askOneKey(rl, 'Choice: ', singleKeyAllowed)
      : await ask(rl, 'Choice: ');
    const raw = (line || '').trim();
    const c = raw.toLowerCase().slice(0, 1);

    if (c === 'q') {
      console.log('\n--- Audit autofix summary ---');
      if (summary.ignored.length) summary.ignored.forEach((s) => console.log('  ', s));
      if (summary.removedStale.length) summary.removedStale.forEach((s) => console.log('  ', s));
      if (summary.prolonged.length) summary.prolonged.forEach((s) => console.log('  ', s));
      if (summary.auditFixRun) console.log('Ran npm audit fix in:', summary.auditFixDirs.join(', '));
      if (summary.overridesAdded.length) summary.overridesAdded.forEach((s) => console.log('  Overridden:', s));
      if (summary.upgraded.length) summary.upgraded.forEach((s) => console.log('  Upgraded:', s));
      const any =
        summary.ignored.length ||
        summary.removedStale.length ||
        summary.prolonged.length ||
        summary.auditFixRun ||
        summary.overridesAdded.length ||
        summary.upgraded.length;
      if (!any) console.log('No changes made.');
      rl.close();
      process.exit(0);
    }

    const num = parseInt(raw, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= state.actionableVulns.length) {
      const vuln = state.actionableVulns[num - 1];
      const ghsaId = vuln.ghsaId;
      console.log('\n--- Vulnerability details ---');
      console.log(vuln.ghsaId || '(no GHSA id)');
      console.log(vuln.title);
      if (vuln.url) console.log(vuln.url);
      console.log('CWE:', vuln.cwe);
      if (ghsaId) {
        console.log('\nFetching full details from GitHub…');
        const info = await fetchGitHubAdvisory(ghsaId);
        if (info) {
          if (info.summary) console.log('\n' + info.summary);
          if (info.description && info.description !== info.summary) {
            const full = info.description.length <= 2500 ? info.description : info.description.slice(0, 2500) + '\n…';
            console.log('\n' + full);
          }
          if (info.html_url) console.log('\n' + info.html_url);
        } else {
          console.log('Could not load full details from GitHub.');
        }
      }

      // Override candidates: the actual leaf-vulnerable transitive packages.
      // We find packages whose `via` array contains a direct advisory object matching
      // this vulnerability's GHSA id, then compute a safe semver range for the override.
      const overrideLeafMap = new Map();
      if (vuln.ghsaId) {
        for (const p of vuln.packages) {
          const auditVulns = ((state.auditResult[p.dir] || {}).vulnerabilities) || {};
          for (const [pkgName, v] of Object.entries(auditVulns)) {
            for (const x of (v.via || [])) {
              if (typeof x !== 'object' || x === null || (!x.title && !x.url)) continue;
              const ids = getAdvisoryIdsFromObj(x);
              if (getGhsaId(ids) !== vuln.ghsaId) continue;
              const key = `${p.dir}:${pkgName}`;
              if (!overrideLeafMap.has(key)) {
                const range = x.range || v.range || '';
                overrideLeafMap.set(key, { packageName: pkgName, range, safeVersion: safeVersionFromVulnRange(range), dir: p.dir });
              }
            }
          }
        }
      }
      const overrideCandidates = [...overrideLeafMap.values()];

      // Upgrade candidates: only direct dependencies whose upgrade pulls in a fixed transitive version.
      // fixAvailable === true means npm audit fix can handle it (semver-compatible transitive update),
      // so we skip those — they belong in the [f] audit fix flow, not manual upgrade.
      // fixAvailable as an object means a specific parent package needs a (potentially major) upgrade;
      // we only offer this if that package is an actual direct dependency to avoid adding new deps.
      const upgradeMap = new Map();
      for (const p of vuln.packages) {
        const fa = p.fixAvailable;
        if (fa && typeof fa === 'object' && fa.name && isDirectDependency(p.dir, fa.name)) {
          const key = `${p.dir}:${fa.name}`;
          if (!upgradeMap.has(key)) {
            upgradeMap.set(key, {
              packageName: fa.name,
              dir: p.dir,
              targetVersion: fa.version || null,
              isSemVerMajor: !!fa.isSemVerMajor,
            });
          }
        }
      }
      const upgradeCandidates = [...upgradeMap.values()];

      if (overrideCandidates.length > 0) {
        console.log('\nOverride candidates (pin transitive package in package.json overrides):');
        overrideCandidates.forEach((c, idx) => {
          const safeStr = c.safeVersion ? `→ safe: ${c.safeVersion}` : `→ vulnerable: ${c.range || '?'} (specify version manually)`;
          console.log(`  ${idx + 1}. ${c.packageName}  [${c.range || '?'}]  ${safeStr}  [${c.dir}]`);
        });
      }
      if (upgradeCandidates.length > 0) {
        console.log('\nUpgrade candidates (direct dependencies — version+date fetched on demand):');
        upgradeCandidates.forEach((c, idx) => {
          const majorTag = c.isSemVerMajor ? ' (MAJOR)' : '';
          const targetTag = c.targetVersion ? ` → ${c.targetVersion}` : '';
          console.log(`  ${idx + 1}. ${c.packageName}${targetTag}${majorTag}  [${c.dir}]`);
        });
      }

      const hasOverride = overrideCandidates.length > 0;
      const hasUpgrade = upgradeCandidates.length > 0;
      const actionOpts = [
        hasOverride ? '(o)verride' : '',
        hasUpgrade ? '(u)pgrade' : '',
        '(i)gnore',
        '(b)ack',
      ].filter(Boolean).join(', ');
      const action = await askOneKey(rl, `\n${actionOpts}? `, 'ioubyn');

      if (action === 'b') {
        return showAndLoop();
      }

      if (action === 'o' && hasOverride) {
        let sel = '';
        if (overrideCandidates.length > 1) {
          const rawSel = await ask(rl, `Which override(s)? (1-${overrideCandidates.length}, comma-separated, or empty for all): `);
          sel = (rawSel || '').trim();
        }
        const indices = !sel
          ? overrideCandidates.map((_, i) => i)
          : sel.split(',').map((s) => parseInt(s.trim(), 10) - 1).filter((i) => Number.isInteger(i) && i >= 0 && i < overrideCandidates.length);
        if (indices.length === 0) {
          console.log('No valid selection; nothing changed.');
          return showAndLoop();
        }
        const modifiedDirs = new Set();
        for (const idx of indices) {
          const cand = overrideCandidates[idx];
          let safeVersion = cand.safeVersion;
          if (!safeVersion) {
            const manualVersion = await ask(rl, `Safe version for ${cand.packageName} (e.g. 2.1.1): `);
            safeVersion = (manualVersion || '').trim();
          }
          if (!safeVersion) { console.log(`Skipping ${cand.packageName} (no version specified).`); continue; }
          const overrideKey = cand.range ? `${cand.packageName}@${cand.range}` : cand.packageName;
          if (addOverrideToPackageJson(cand.dir, overrideKey, safeVersion)) {
            modifiedDirs.add(cand.dir);
            summary.overridesAdded.push(`"${overrideKey}": "${safeVersion}" in ${cand.dir}`);
          }
        }
        if (modifiedDirs.size === 0) {
          console.log('Override already present or no package.json updated.');
          return showAndLoop();
        }
        console.log('Running npm install in modified folders to apply overrides…');
        for (const dir of modifiedDirs) {
          try { runNpmInstall(dir); } catch { console.log(`npm install in ${dir} had non-zero exit.`); }
        }
        rewriteLockfilesRegistry();
        console.log('Override(s) applied. Re-running audit…');
        return showAndLoop();
      }

      if (action === 'u' && hasUpgrade) {
        console.log('\nFetching latest versions from npm…');
        const withVersions = await Promise.all(
          upgradeCandidates.map(async (c) => {
            const info = await fetchNpmPackageInfo(c.packageName);
            const version = info?.latestVersion || 'latest';
            const date = (info?.time || {})[version];
            const dateStr = date ? new Date(date).toISOString().slice(0, 10) : '-';
            return { ...c, version, dateStr };
          })
        );
        console.log('\nLatest available versions:');
        withVersions.forEach((c, idx) => {
          console.log(`  ${idx + 1}. ${c.packageName}@${c.version}  released: ${c.dateStr}  [${c.dir}]`);
        });
        let sel = '';
        if (withVersions.length > 1) {
          const rawSel = await ask(rl, `Which upgrade(s)? (1-${withVersions.length}, comma-separated, or empty for all): `);
          sel = (rawSel || '').trim();
        }
        const indices = !sel
          ? withVersions.map((_, i) => i)
          : sel.split(',').map((s) => parseInt(s.trim(), 10) - 1).filter((i) => Number.isInteger(i) && i >= 0 && i < withVersions.length);
        if (indices.length === 0) {
          console.log('No valid selection; nothing changed.');
          return showAndLoop();
        }
        const modifiedDirs = new Set();
        for (const idx of indices) {
          const cand = withVersions[idx];
          const spec = `${cand.packageName}@${cand.version}`;
          try {
            runNpmInstallPackage(cand.dir, cand.packageName, cand.version);
            modifiedDirs.add(cand.dir);
            summary.upgraded.push(`${spec} in ${cand.dir}`);
          } catch {
            console.log(`npm install ${spec} in ${cand.dir} had non-zero exit.`);
          }
        }
        if (modifiedDirs.size === 0) {
          console.log('No packages upgraded.');
          return showAndLoop();
        }
        rewriteLockfilesRegistry();
        console.log('Upgrade(s) applied. Re-running audit…');
        return showAndLoop();
      }

      const confirm = action === 'i' || action === 'y' ? 'y' : 'n';
      if (confirm !== 'y') {
        return showAndLoop();
      }
      if (!ghsaId) {
        console.log('No GHSA id; cannot add to .nsprc.');
        return showAndLoop();
      }
      const reason = await ask(rl, 'Reason (optional): ');
      const expiryMs = addMonthMs();
      const dirs = [...new Set(vuln.packages.map((p) => p.dir))];
      for (const dir of dirs) {
        const nsprc = { ...state.nsprc[dir] };
        ignoreFinding(nsprc, vuln.packages[0].advisoryIds, reason.trim(), expiryMs);
        writeNsprc(dir, nsprc);
      }
      summary.ignored.push(`${ghsaId} (${dirs.join(', ')})`);
      console.log('Added ignore (expiry +1 month).');
      return showAndLoop();
    }

    if (c === 'a' && state.actionableVulns.length > 0) {
      const reason = await ask(rl, 'Reason for ignoring all (optional): ');
      const expiryMs = addMonthMs();
      const notes = reason.trim();
      for (const v of state.actionableVulns) {
        if (!v.ghsaId) continue;
        const dirs = [...new Set(v.packages.map((p) => p.dir))];
        for (const dir of dirs) {
          const nsprc = { ...state.nsprc[dir] };
          ignoreFinding(nsprc, v.packages[0].advisoryIds, notes, expiryMs);
          writeNsprc(dir, nsprc);
        }
        summary.ignored.push(`${v.ghsaId} (${dirs.join(', ')})`);
      }
      console.log('Ignored all (expiry +1 month).');
      return showAndLoop();
    }

    if (c === 'p' && outdated.length > 0) {
      const nRaw = await ask(rl, `Prolong which? (1-${outdated.length}): `);
      const n = parseInt((nRaw || '').trim(), 10);
      if (Number.isNaN(n) || n < 1 || n > outdated.length) {
        console.log('Invalid number.');
        return showAndLoop();
      }
      const entry = state.outdated[n - 1];
      const nsprc = { ...state.nsprc[entry.dir] };
      const current = nsprc[entry.key];
      nsprc[entry.key] = typeof current === 'object' && current !== null ? { ...current, expiry: addMonthMs() } : { active: true, expiry: addMonthMs(), notes: '' };
      writeNsprc(entry.dir, nsprc);
      state.nsprc[entry.dir] = nsprc;
      summary.prolonged.push(`${entry.key} (${entry.dir})`);
      console.log('Prolonged by 1 month.');
      return showAndLoop();
    }

    if (c === 'o' && state.actionableVulns.length > 0) {
      const nRaw = await ask(rl, `Add override for which vulnerability? (1-${state.actionableVulns.length}): `);
      const n = parseInt((nRaw || '').trim(), 10);
      if (Number.isNaN(n) || n < 1 || n > state.actionableVulns.length) {
        console.log('Invalid number.');
        return showAndLoop();
      }
      const vuln = state.actionableVulns[n - 1];
      const firstPkg = vuln.packages[0];
      const fa = firstPkg.fixAvailable;
      let packageName = firstPkg.package;
      let version = null;
      if (fa && typeof fa === 'object' && fa.name) {
        packageName = fa.name;
        version = fa.version || null;
      }
      if (!version) {
        version = await ask(rl, `Version to override "${packageName}" to (e.g. ^2.1.0): `);
        version = (version || '').trim();
      } else {
        version = version.startsWith('^') || version.startsWith('~') ? version : `^${version}`;
      }
      if (!version) {
        console.log('No version given; skipping.');
        return showAndLoop();
      }
      const dirs = [...new Set(vuln.packages.map((p) => p.dir))];
      for (const dir of dirs) {
        if (addOverride(dir, packageName, version)) {
          try {
            execSync('npm install', { cwd: join(ROOT, dir), stdio: 'inherit' });
          } catch (_) {
            console.log(`npm install in ${dir} had non-zero exit.`);
          }
          summary.overrides.push(`${dir}: ${packageName}@${version}`);
        }
      }
      if (summary.overrides.length > 0) console.log('Override(s) added. Re-running audit…');
      return showAndLoop();
    }

    if (c === 'f') {
      const affectedDirs = [...new Set(state.actionableVulns.flatMap((v) => v.packages.map((p) => p.dir)))];
      if (affectedDirs.length === 0) {
        console.log('No affected folders (no actionable vulnerabilities).');
      } else {
        for (const dir of affectedDirs) {
          try {
            execSync('npm audit fix', { cwd: join(ROOT, dir), stdio: 'inherit' });
          } catch (_) {
            console.log(`audit fix in ${dir} had non-zero exit.`);
          }
        }
        summary.auditFixRun = true;
        summary.auditFixDirs = affectedDirs;
        console.log('Ran audit fix in affected folders:', affectedDirs.join(', '));
        rewriteLockfilesRegistry();
      }
      return showAndLoop();
    }

    if (c === 'o') {
      const overrideKey = await ask(rl, 'Override key (e.g. multer@2.1.0 or fast-xml-parser): ');
      if (!overrideKey.trim()) {
        console.log('Empty key; nothing added.');
        return showAndLoop();
      }
      const overrideValue = await ask(rl, 'Override version (e.g. 2.1.1): ');
      if (!overrideValue.trim()) {
        console.log('Empty version; nothing added.');
        return showAndLoop();
      }
      const pkgName = packageNameFromOverrideKey(overrideKey.trim());
      const dirsWithPkg = PACKAGES.filter((d) => existsSync(join(ROOT, d, 'package.json')) && isInDependencyTree(d, pkgName));
      if (dirsWithPkg.length === 0) {
        console.log(`Package "${pkgName}" not found in any dependency tree. Nothing to override.`);
        return showAndLoop();
      }
      const dirPrompt = await ask(rl, `Folders (comma-separated, or Enter for detected [${dirsWithPkg.join(',')}]): `);
      const dirList =
        (dirPrompt || '')
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean).length > 0
          ? (dirPrompt || '').split(',').map((d) => d.trim()).filter(Boolean)
          : dirsWithPkg;
      const validDirs = dirList.filter((d) => PACKAGES.includes(d) && existsSync(join(ROOT, d, 'package.json')) && isInDependencyTree(d, pkgName));
      if (validDirs.length === 0) {
        console.log(`Package "${pkgName}" not in the dependency tree of the selected folders.`);
        return showAndLoop();
      }
      const modified = [];
      for (const dir of validDirs) {
        if (addOverrideToPackageJson(dir, overrideKey.trim(), overrideValue.trim())) modified.push(dir);
      }
      if (modified.length === 0) {
        console.log('Override already present or no package.json updated.');
        return showAndLoop();
      }
      console.log('Running npm install in modified folders to apply overrides…');
      for (const dir of modified) {
        try {
          runNpmInstall(dir);
        } catch (_) {
          console.log(`npm install in ${dir} had non-zero exit.`);
        }
      }
      rewriteLockfilesRegistry();
      summary.overridesAdded.push(`"${overrideKey.trim()}": "${overrideValue.trim()}" in ${modified.join(', ')}`);
      console.log('Override added. Re-running audit…');
      return showAndLoop();
    }

    console.log('Unknown option.');
    return showAndLoop();
  }

  showAndLoop().catch((err) => {
    console.error(err);
    rl.close();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
