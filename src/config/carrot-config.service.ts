import { ICarrotConfig, CARROT_CONFIG_DEFAULTS } from './carrot-config.types';

interface IFileContentReader {
  getFileContent(
    project: string,
    slug: string,
    filePath: string,
    opts?: { at?: string; quiet?: boolean },
  ): Promise<string | null>;
}

export function stripJsoncComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\') {
        // Escape sequence: consume both characters verbatim
        result += ch;
        i++;
        if (i < text.length) {
          result += text[i];
          i++;
        }
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      result += ch;
      i++;
      continue;
    }

    // Not in string
    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    // Check for single-line comment
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      // Skip until end of line
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Check for block comment
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      i += 2;
      while (i < text.length) {
        if (text[i] === '*' && i + 1 < text.length && text[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

export function parseCarrotConfig(raw: string): ICarrotConfig | null {
  try {
    const stripped = stripJsoncComments(raw);
    const parsed = JSON.parse(stripped) as Partial<ICarrotConfig>;

    const config: ICarrotConfig = {
      ...CARROT_CONFIG_DEFAULTS,
      ...parsed,
    } as ICarrotConfig;

    return config;
  } catch {
    return null;
  }
}

export class CarrotConfigService {
  private readonly provider: IFileContentReader;
  private readonly cache = new Map<string, ICarrotConfig | null>();
  /** Repos where `.carrot.jsonc` is missing (404), accumulated for one poll cycle summary. */
  private readonly cycleMissingFile = new Set<string>();
  /** Repos where the file exists but JSON/config is invalid, accumulated for one poll cycle summary. */
  private readonly cycleInvalidFile = new Set<string>();

  constructor(provider: IFileContentReader) {
    this.provider = provider;
  }

  /** Clears resolved-config cache (call each poll cycle). */
  public clearCache(): void {
    this.cache.clear();
  }

  /** Clears per-cycle gap lists; call at the start of the Bitbucket PR poll cycle only. */
  public resetCycleCarrotGaps(): void {
    this.cycleMissingFile.clear();
    this.cycleInvalidFile.clear();
  }

  /** Snapshot of repos with missing or invalid `.carrot.jsonc` for the current PR poll cycle. */
  public getCycleCarrotGaps(): { missingFile: string[]; invalidFile: string[] } {
    return {
      missingFile: [...this.cycleMissingFile].sort(),
      invalidFile: [...this.cycleInvalidFile].sort(),
    };
  }

  public async getConfig(
    project: string,
    slug: string,
    opts?: { recordCycleGaps?: boolean },
  ): Promise<ICarrotConfig | null> {
    const recordCycleGaps = opts?.recordCycleGaps !== false;
    const cacheKey = `${project}/${slug}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) ?? null;
    }

    const raw = await this.provider.getFileContent(project, slug, '.carrot.jsonc', { quiet: true });

    if (raw === null) {
      if (recordCycleGaps) this.cycleMissingFile.add(cacheKey);
      this.cache.set(cacheKey, null);
      return null;
    }

    const config = parseCarrotConfig(raw);

    if (config === null) {
      if (recordCycleGaps) this.cycleInvalidFile.add(cacheKey);
    }

    this.cache.set(cacheKey, config);
    return config;
  }
}
