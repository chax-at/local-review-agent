import { describe, it, expect } from 'vitest';
import { formatFindingAttribution, attributionSuffix } from '../../src/reviewer/finding-attribution';
import type { IAuthoredFinding } from '../../src/types';

function finding(over: Partial<IAuthoredFinding> = {}): IAuthoredFinding {
  return { filePath: 'a.ts', line: 1, severity: 'concern', comment: 'bug', author: 'R1', ...over };
}

describe('formatFindingAttribution', () => {
  it('renders a single finding as author (persona)', () => {
    expect(formatFindingAttribution(finding({ persona: 'security' }))).toBe('R1 (security)');
  });

  it('renders just the author when there is no persona', () => {
    expect(formatFindingAttribution(finding())).toBe('R1');
  });

  it('renders merged sources from different models as a comma list', () => {
    const f = finding({
      sources: [
        { author: 'R1', persona: 'security' },
        { author: 'R2', persona: 'generic' },
      ],
    });
    expect(formatFindingAttribution(f)).toBe('R1 (security), R2 (generic)');
  });

  it('groups multiple personas of the same model into one parenthesis', () => {
    const f = finding({
      sources: [
        { author: 'R1', persona: 'security' },
        { author: 'R2', persona: 'generic' },
        { author: 'R1', persona: 'correctness' },
      ],
    });
    expect(formatFindingAttribution(f)).toBe('R1 (security, correctness), R2 (generic)');
  });

  it('deduplicates repeated (author, persona) pairs', () => {
    const f = finding({
      sources: [
        { author: 'R1', persona: 'security' },
        { author: 'R1', persona: 'security' },
      ],
    });
    expect(formatFindingAttribution(f)).toBe('R1 (security)');
  });

  it('handles a sourceless model entry mixed with persona entries', () => {
    const f = finding({
      sources: [{ author: 'R1' }, { author: 'R2', persona: 'generic' }],
    });
    expect(formatFindingAttribution(f)).toBe('R1, R2 (generic)');
  });

  it('returns empty string when there is no author at all', () => {
    expect(formatFindingAttribution(finding({ author: '' }))).toBe('');
  });
});

describe('attributionSuffix', () => {
  it('wraps the attribution in an italic Found-by line', () => {
    expect(attributionSuffix(finding({ persona: 'security' }))).toBe('\n\n*Found by R1 (security)*');
  });

  it('returns empty string when there is nothing to attribute', () => {
    expect(attributionSuffix(finding({ author: '' }))).toBe('');
  });
});
