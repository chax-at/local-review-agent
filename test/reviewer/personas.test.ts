import { describe, it, expect } from 'vitest';
import {
  REVIEW_PERSONAS,
  PERSONA_DIRECTIVES,
  parseRoles,
  assertCorrectnessCovered,
  buildReviewPrompt,
} from '../../src/reviewer/personas';

describe('parseRoles', () => {
  it('parses a single role', () => {
    expect(parseRoles('security', 'Model2')).toEqual(['security']);
  });

  it('parses multiple roles and is case/space insensitive', () => {
    expect(parseRoles(' Security , Correctness ', 'Model2')).toEqual(['security', 'correctness']);
  });

  it('defaults are NOT applied here — "generic" is just a normal role', () => {
    expect(parseRoles('generic', 'Model1')).toEqual(['generic']);
  });

  it('throws on a blank string (use Review:false to opt out)', () => {
    expect(() => parseRoles('   ', 'Model3')).toThrow(/Model3\.Roles is blank/);
  });

  it('throws on an empty entry from a stray comma', () => {
    expect(() => parseRoles('security,', 'Model3')).toThrow(/empty entry/);
  });

  it('throws on an unknown role, naming the model and token', () => {
    expect(() => parseRoles('securty', 'Model4')).toThrow(/Model4\.Roles has unknown role "securty"/);
  });

  it('throws on a duplicate role', () => {
    expect(() => parseRoles('security,security', 'Model2')).toThrow(/duplicate role "security"/);
  });
});

describe('assertCorrectnessCovered', () => {
  it('passes when a model has the correctness role', () => {
    expect(() => assertCorrectnessCovered([['security'], ['correctness']])).not.toThrow();
  });

  it('passes when a model is generic (generic covers correctness)', () => {
    expect(() => assertCorrectnessCovered([['security'], ['generic']])).not.toThrow();
  });

  it('throws when no model covers correctness or generic', () => {
    expect(() => assertCorrectnessCovered([['security'], ['readability']])).toThrow(/No review model covers correctness/);
  });
});

describe('buildReviewPrompt', () => {
  it('embeds the directive and omits the comments line when there are none', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.security, false);
    expect(prompt).toContain(PERSONA_DIRECTIVES.security);
    expect(prompt).toContain('Ignore lock files');
    expect(prompt).not.toContain('existing-comments.md');
  });

  it('appends the comments line when existing comments are present', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.generic, true);
    expect(prompt).toContain('existing-comments.md');
  });

  it('generic directive equals the current hardcoded focus line', () => {
    expect(PERSONA_DIRECTIVES.generic).toBe('Focus on: security issues, bugs, code standard violations.');
  });

  it('every allowlisted persona has a directive', () => {
    for (const p of REVIEW_PERSONAS) {
      expect(typeof PERSONA_DIRECTIVES[p]).toBe('string');
      expect(PERSONA_DIRECTIVES[p].length).toBeGreaterThan(0);
    }
  });
});
