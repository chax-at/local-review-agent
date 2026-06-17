import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import { safeVersionFromVulnRange } from './audit.types';

const NPM_REGISTRY = 'https://registry.npmjs.org/';
const TIMEOUT_MS = 15_000;

export interface INpmVersionInfo {
  version: string;
  publishedAt: string | null;
}

export interface INpmRepoInfo {
  repoUrl: string | null;
  changelogUrl: string | null;
  compareUrl: string | null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}

function isStableSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

function extractGithubUrl(repository: unknown): string | null {
  if (!repository) return null;
  const url = typeof repository === 'string' ? repository : (repository as { url?: string }).url;
  if (!url) return null;
  const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) return null;
  return `https://github.com/${match[1]}`;
}

export class NpmRegistryClient {
  private async fetchJson(url: string): Promise<unknown | null> {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'local-git-reviewer' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'local-git-reviewer' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  public async getNextSafeVersion(packageName: string, vulnerableRange: string): Promise<string | null> {
    try {
      const data = (await this.fetchJson(`${NPM_REGISTRY}${encodeURIComponent(packageName)}`)) as {
        versions?: Record<string, unknown>;
      } | null;
      if (!data?.versions) return null;

      const boundary = safeVersionFromVulnRange(vulnerableRange);
      if (!boundary) return null;

      const allVersions = Object.keys(data.versions).filter(isStableSemver).sort(compareSemver);

      if (isStableSemver(boundary)) {
        if (allVersions.includes(boundary)) return boundary;
        const next = allVersions.find((v) => compareSemver(v, boundary) > 0);
        return next ?? null;
      }

      const gtMatch = boundary.match(/^>(\d+\.\d+\.\d+)$/);
      if (gtMatch) {
        const above = gtMatch[1];
        const next = allVersions.find((v) => compareSemver(v, above) > 0);
        return next ?? null;
      }

      return null;
    } catch (err) {
      LogSink.debug(`NpmRegistryClient.getNextSafeVersion failed for ${packageName}: ${err}`, TraceTags.AUDIT);
      return null;
    }
  }

  public async getRepoInfo(packageName: string, fromVersion: string, toVersion: string): Promise<INpmRepoInfo> {
    const data = (await this.fetchJson(`${NPM_REGISTRY}${encodeURIComponent(packageName)}`)) as {
      repository?: unknown;
    } | null;
    const repoUrl = data ? extractGithubUrl(data.repository) : null;

    return {
      repoUrl,
      changelogUrl: repoUrl ? `${repoUrl}/blob/main/CHANGELOG.md` : null,
      compareUrl: repoUrl ? `${repoUrl}/compare/v${fromVersion}...v${toVersion}` : null,
    };
  }

  public async getChangelog(
    packageName: string,
    fromVersion: string,
    toVersion: string,
    repoUrl: string | null,
    maxBytes = 200_000,
  ): Promise<string | null> {
    if (!repoUrl) return null;

    const match = repoUrl.match(/github\.com\/(.+)/);
    if (!match) return null;
    const repoPath = match[1];

    const releases = (await this.fetchJson(`https://api.github.com/repos/${repoPath}/releases?per_page=100`)) as
      | { tag_name: string; body?: string }[]
      | null;

    if (releases && releases.length > 0) {
      const relevant = releases.filter((r) => {
        const tag = r.tag_name.replace(/^v/, '');
        if (!isStableSemver(tag)) return false;
        return compareSemver(tag, fromVersion) > 0 && compareSemver(tag, toVersion) <= 0;
      });

      if (relevant.length > 0) {
        const combined = relevant
          .sort((a, b) => compareSemver(a.tag_name.replace(/^v/, ''), b.tag_name.replace(/^v/, '')))
          .map((r) => `## ${r.tag_name}\n\n${r.body ?? ''}`)
          .join('\n\n---\n\n');
        if (combined.length <= maxBytes) return combined;
        return null;
      }
    }

    const raw = await this.fetchText(`https://raw.githubusercontent.com/${repoPath}/main/CHANGELOG.md`);
    if (raw && raw.length <= maxBytes) return raw;

    return null;
  }

  public async getLatestVersion(packageName: string): Promise<INpmVersionInfo | null> {
    const data = (await this.fetchJson(`${NPM_REGISTRY}${encodeURIComponent(packageName)}`)) as {
      'dist-tags'?: { latest?: string };
      time?: Record<string, string>;
    } | null;

    if (!data?.['dist-tags']?.latest) return null;
    const version = data['dist-tags'].latest;
    return { version, publishedAt: data.time?.[version] ?? null };
  }
}
