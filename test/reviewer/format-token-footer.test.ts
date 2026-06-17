import { describe, it, expect } from 'vitest';
import { formatTokenFooter } from '../../src/reviewer/reviewer.service';

describe('formatTokenFooter', () => {
  it('aggregates duplicate model names into one row with summed totals', () => {
    const usage = [
      { modelName: 'M1', inputTokens: 100, outputTokens: 50, costEur: 0.01 },
      { modelName: 'M1', inputTokens: 200, outputTokens: 80, costEur: 0.02 },
      { modelName: 'M1', inputTokens: 50, outputTokens: 30, costEur: 0.005 },
      { modelName: 'M2', inputTokens: 300, outputTokens: 100, costEur: 0.04 },
    ];
    const out = formatTokenFooter(usage);

    const m1Matches = out.match(/M1: ([\d,]+) in \/ ([\d,]+) out/g);
    expect(m1Matches).toHaveLength(1);
    expect(out).toContain('M1: 350 in / 160 out');
    expect(out).toContain('M2: 300 in / 100 out');
    expect(out).toContain('0.0750 EUR');
  });

  it('shows n/a when there are no costs', () => {
    const out = formatTokenFooter([
      { modelName: 'M1', inputTokens: 100, outputTokens: 50, costEur: 0 },
    ]);
    expect(out).toContain('M1: 100 in / 50 out');
    expect(out).toContain('Est. cost: n/a');
  });

  it('handles empty usage', () => {
    const out = formatTokenFooter([]);
    expect(out).toContain('Est. cost: n/a');
  });
});
