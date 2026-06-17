import { describe, it, expect } from 'vitest';
import { filterExcludedFindings } from '../../src/reviewer/finding-filter';
import type { IAuthoredFinding } from '../../src/types';

const f = (filePath: string, line = 1): IAuthoredFinding => ({
  filePath, line, severity: 'concern', comment: 'x', author: 'R1',
});

describe('filterExcludedFindings', () => {
  it('drops lockfile findings silently (not counted as skipped large files)', () => {
    const findings = [f('package-lock.json'), f('src/a.ts')];
    const res = filterExcludedFindings(findings, new Map([['src/a.ts', 10]]), 1000);
    expect(res.kept.map((x) => x.filePath)).toEqual(['src/a.ts']);
    expect(res.skippedLargeFiles).toEqual([]);
  });

  it('drops findings on files over the line limit and records the distinct paths', () => {
    const findings = [f('big.ts', 1), f('big.ts', 2), f('small.ts')];
    const counts = new Map([['big.ts', 1500], ['small.ts', 20]]);
    const res = filterExcludedFindings(findings, counts, 1000);
    expect(res.kept.map((x) => x.filePath)).toEqual(['small.ts']);
    expect(res.skippedLargeFiles).toEqual(['big.ts']); // distinct, once
  });

  it('keeps findings when the line count is unknown (fetch failed)', () => {
    const findings = [f('unknown.ts')];
    const res = filterExcludedFindings(findings, new Map(), 1000);
    expect(res.kept).toHaveLength(1);
    expect(res.skippedLargeFiles).toEqual([]);
  });

  it('keeps a file exactly at the limit', () => {
    const res = filterExcludedFindings([f('edge.ts')], new Map([['edge.ts', 1000]]), 1000);
    expect(res.kept).toHaveLength(1);
  });
});
