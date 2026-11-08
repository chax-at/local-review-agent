import { describe, it, expect } from 'vitest';
import { buildPiVerificationInputs, mapVerificationResultsBack } from '../../src/reviewer/reviewer.service';
import type { IAuthoredFinding } from '../../src/types';

describe('buildPiVerificationInputs', () => {
  it("maps global finding indices to pi's local 0..N-1 indexing", () => {
    const findings: IAuthoredFinding[] = [
      { filePath: 'a.ts', line: 1, severity: 'concern', comment: 'A', author: 'R1' },
      { filePath: 'b.ts', line: 2, severity: 'suggestion', comment: 'B', author: 'R1' },
      { filePath: 'c.ts', line: 3, severity: 'note', comment: 'C', author: 'R1' },
    ];
    expect(buildPiVerificationInputs(findings, [2, 0])).toEqual([
      { index: 0, filePath: 'c.ts', line: 3, comment: 'C' },
      { index: 1, filePath: 'a.ts', line: 1, comment: 'A' },
    ]);
  });

  it('returns an empty array for no split findings', () => {
    expect(buildPiVerificationInputs([], [])).toEqual([]);
  });
});

describe('mapVerificationResultsBack', () => {
  it("remaps pi's local indices back to the original global finding indices", () => {
    const local = new Map([
      [0, { supported: true, evidence: 'e0' }],
      [1, { supported: false, evidence: 'e1' }],
    ]);
    expect(mapVerificationResultsBack(local, [2, 0])).toEqual(
      new Map([
        [2, { supported: true, evidence: 'e0' }],
        [0, { supported: false, evidence: 'e1' }],
      ]),
    );
  });

  it('drops an out-of-range local index instead of throwing', () => {
    const local = new Map([[5, { supported: true, evidence: 'stray' }]]);
    expect(mapVerificationResultsBack(local, [0, 1])).toEqual(new Map());
  });
});
