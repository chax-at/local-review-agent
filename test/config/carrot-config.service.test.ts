import { describe, it, expect } from 'vitest';
import { stripJsoncComments, parseCarrotConfig } from '../../src/config/carrot-config.service';

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
    expect(config!.packages).toEqual(['.']);
    expect(config!.prReview).toBe(true);
    expect(config!.bambooFix).toBe(false);
    expect(config!.fixDelivery).toBe('protected-only');
    expect(config!.protectedBranches).toEqual(['main', 'master', 'release/*']);
  });

  it('accepts bambooFix without auditChannel', () => {
    const config = parseCarrotConfig('{ "bambooFix": true }');
    expect(config).not.toBeNull();
    expect(config!.bambooFix).toBe(true);
  });

  it('accepts bambooFix with all fields', () => {
    const config = parseCarrotConfig('{ "bambooFix": true, "packages": [".", "frontend"] }');
    expect(config).not.toBeNull();
    expect(config!.bambooFix).toBe(true);
    expect(config!.packages).toEqual(['.', 'frontend']);
  });

  it('strips JSONC comments before parsing', () => {
    const input = '{\n  // Enable reviews\n  "prReview": true\n}';
    const config = parseCarrotConfig(input);
    expect(config).not.toBeNull();
    expect(config!.prReview).toBe(true);
  });
});
