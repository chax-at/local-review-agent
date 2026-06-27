import { describe, it, expect } from 'vitest';
import {
  stripJsoncComments,
  parseCarrotConfig,
  CarrotConfigService,
} from '../../src/config/carrot-config.service';

function makeReader(files: Record<string, string | null>) {
  const requested: string[] = [];
  return {
    requested,
    getFileContent: async (_project: string, _slug: string, filePath: string) => {
      requested.push(filePath);
      return files[filePath] ?? null;
    },
  };
}

describe('stripJsoncComments', () => {
  it('strips single-line comments', () => {
    const input = '{\n  // comment\n  "key": "value"\n}';
    expect(stripJsoncComments(input)).toBe('{\n  \n  "key": "value"\n}');
  });

  it('strips block comments', () => {
    const input = '{ /* block */ "key": "value" }';
    expect(stripJsoncComments(input)).toBe('{  "key": "value" }');
  });

  it('does not strip comments inside strings', () => {
    const input = '{ "key": "value // not a comment" }';
    expect(stripJsoncComments(input)).toBe('{ "key": "value // not a comment" }');
  });

  it('handles multi-line block comments', () => {
    const input = '{\n  /*\n   * multi\n   * line\n   */\n  "key": 1\n}';
    expect(stripJsoncComments(input)).toBe('{\n  \n  "key": 1\n}');
  });
});

describe('parseCarrotConfig', () => {
  it('returns null for invalid JSON', () => {
    expect(parseCarrotConfig('not json')).toBeNull();
  });

  it('applies defaults for missing fields', () => {
    const config = parseCarrotConfig('{ "prReview": true }');
    expect(config).not.toBeNull();
    expect(config!.prReview).toBe(true);
    expect(config!.rulesFiles).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });

  it('strips JSONC comments before parsing', () => {
    const input = '{\n  // Enable reviews\n  "prReview": true\n}';
    const config = parseCarrotConfig(input);
    expect(config).not.toBeNull();
    expect(config!.prReview).toBe(true);
  });
});

describe('CarrotConfigService', () => {
  it('reads config from .chaxy.jsonc', async () => {
    const reader = makeReader({ '.chaxy.jsonc': '{ "prReview": true }' });
    const service = new CarrotConfigService(reader);

    const config = await service.getConfig('PROJ', 'repo');

    expect(config?.prReview).toBe(true);
  });

  it('falls back to .carrot.jsonc when .chaxy.jsonc is absent', async () => {
    const reader = makeReader({ '.carrot.jsonc': '{ "prReview": true }' });
    const service = new CarrotConfigService(reader);

    const config = await service.getConfig('PROJ', 'repo');

    expect(config?.prReview).toBe(true);
    expect(reader.requested).toContain('.chaxy.jsonc');
  });

  it('returns null and records the repo as missing when neither file exists', async () => {
    const reader = makeReader({});
    const service = new CarrotConfigService(reader);

    const config = await service.getConfig('PROJ', 'repo');

    expect(config).toBeNull();
    expect(service.getCycleCarrotGaps().missingFile).toContain('PROJ/repo');
  });
});
