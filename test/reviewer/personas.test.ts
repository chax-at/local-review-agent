import { describe, it, expect } from 'vitest';
import {
  REVIEW_PERSONAS,
  PERSONA_DIRECTIVES,
  parseRoles,
  isCorrectnessCovered,
  buildReviewPrompt,
} from '../../src/reviewer/personas';

describe('parseRoles', () => {
  it('parses a single role', () => {
    expect(parseRoles('security', 'Model2')).toEqual(['security']);
  });

  it('parses multiple roles and is case/space insensitive', () => {
    expect(parseRoles(' Security , Correctness ', 'Model2')).toEqual(['security', 'correctness']);
  });

  it('parses the vegetable-police role', () => {
    expect(parseRoles('vegetable-police', 'Model2')).toEqual(['vegetable-police']);
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

describe('isCorrectnessCovered', () => {
  it('true when a model has the correctness role', () => {
    expect(isCorrectnessCovered([['security'], ['correctness']])).toBe(true);
  });

  it('true when a model is generic (generic covers correctness)', () => {
    expect(isCorrectnessCovered([['security'], ['generic']])).toBe(true);
  });

  it('false when no model covers correctness or generic — a warning case, never a startup failure', () => {
    expect(isCorrectnessCovered([['security'], ['readability']])).toBe(false);
    expect(isCorrectnessCovered([['vegetable-police']])).toBe(false);
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

  it('appends the context.md line when repository context is attached', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.generic, false, true);
    expect(prompt).toContain('context.md');
    expect(prompt).toContain('only report findings on lines that appear in the diff');
  });

  it('omits the context.md line when no repository context was gathered', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.generic, false, false);
    expect(prompt).not.toContain('context.md');
  });

  it('generic directive equals the current hardcoded focus line', () => {
    expect(PERSONA_DIRECTIVES.generic).toBe('Focus on: security issues, bugs, code standard violations.');
  });

  it('appends the pr-context.md line when PR/ticket intent info is attached', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.generic, false, false, true);
    expect(prompt).toContain('pr-context.md');
  });

  it('omits the pr-context.md line when there is no PR/ticket info', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.generic, false, false, false);
    expect(prompt).not.toContain('pr-context.md');
  });

  it('appends the scanner-findings.md line when scanner output is attached', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.security, false, false, false, true);
    expect(prompt).toContain('scanner-findings.md');
    expect(prompt).toContain('cross-check');
  });

  it('omits the scanner-findings.md line when there is no scanner output', () => {
    const prompt = buildReviewPrompt(PERSONA_DIRECTIVES.security, false, false, false, false);
    expect(prompt).not.toContain('scanner-findings.md');
  });

  it('vegetable-police directive grounds the review in standards.md and demands rule citations', () => {
    const directive = PERSONA_DIRECTIVES['vegetable-police'];
    expect(directive).toContain('standards.md');
    expect(directive.toLowerCase()).toContain('cite');
  });

  it('every allowlisted persona has a directive', () => {
    for (const p of REVIEW_PERSONAS) {
      expect(typeof PERSONA_DIRECTIVES[p]).toBe('string');
      expect(PERSONA_DIRECTIVES[p].length).toBeGreaterThan(0);
    }
  });
});
