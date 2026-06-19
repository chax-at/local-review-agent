import { describe, it, expect } from 'vitest';
import { expandReviewerRuns, type IReviewModel } from '../../src/reviewer/reviewer.service';

const model = (name: string, roles: IReviewModel['roles']): IReviewModel =>
  ({ name, roles, pi: {} as IReviewModel['pi'], inputCostPer1M: 0, outputCostPer1M: 0 });

describe('expandReviewerRuns', () => {
  it('produces one run per (model, role) pair', () => {
    const runs = expandReviewerRuns([model('A', ['correctness', 'security']), model('B', ['generic'])]);
    expect(runs.map((r) => `${r.model.name}:${r.role}`)).toEqual(['A:correctness', 'A:security', 'B:generic']);
  });

  it('returns an empty list when there are no reviewers', () => {
    expect(expandReviewerRuns([])).toEqual([]);
  });
});
