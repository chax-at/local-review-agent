import { describe, it, expect } from 'vitest';
import { expandReviewerRuns, filterRunsByStandards, type IReviewModel } from '../../src/reviewer/reviewer.service';

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

describe('filterRunsByStandards', () => {
  it('skips vegetable-police runs when the repo has no guideline files', () => {
    const runs = expandReviewerRuns([model('A', ['generic', 'vegetable-police'])]);
    const { active, skipped } = filterRunsByStandards(runs, false);
    expect(active.map((r) => r.role)).toEqual(['generic']);
    expect(skipped.map((r) => r.role)).toEqual(['vegetable-police']);
  });

  it('keeps vegetable-police runs when guideline files exist', () => {
    const runs = expandReviewerRuns([model('A', ['vegetable-police']), model('B', ['security'])]);
    const { active, skipped } = filterRunsByStandards(runs, true);
    expect(active.map((r) => `${r.model.name}:${r.role}`)).toEqual(['A:vegetable-police', 'B:security']);
    expect(skipped).toEqual([]);
  });

  it('never skips personas that do not depend on guidelines', () => {
    const runs = expandReviewerRuns([model('A', ['correctness', 'security', 'readability', 'generic'])]);
    const { active, skipped } = filterRunsByStandards(runs, false);
    expect(active).toHaveLength(4);
    expect(skipped).toEqual([]);
  });

  it('can skip every run when only police roles are configured and no guidelines exist', () => {
    const runs = expandReviewerRuns([model('A', ['vegetable-police']), model('B', ['vegetable-police'])]);
    const { active, skipped } = filterRunsByStandards(runs, false);
    expect(active).toEqual([]);
    expect(skipped).toHaveLength(2);
  });
});
