import type { IAuthoredFinding } from '../types';
import { isLockfile } from './diff.utils';

export interface IExclusionResult {
  kept: IAuthoredFinding[];
  /** Distinct file paths dropped for exceeding maxFileLines, in first-seen order. */
  skippedLargeFiles: string[];
}

/**
 * Remove findings that should never be reviewed:
 * - lockfiles (dropped silently)
 * - files whose full line count exceeds `maxFileLines` (recorded in skippedLargeFiles)
 *
 * `fileLineCounts` maps filePath -> full file line count. A path absent from the
 * map has an unknown count and is NOT dropped (fetch failure must not lose findings).
 */
export function filterExcludedFindings(
  findings: IAuthoredFinding[],
  fileLineCounts: Map<string, number>,
  maxFileLines: number,
): IExclusionResult {
  const kept: IAuthoredFinding[] = [];
  const skipped = new Set<string>();

  for (const finding of findings) {
    if (isLockfile(finding.filePath)) continue;
    const count = fileLineCounts.get(finding.filePath);
    if (count !== undefined && count > maxFileLines) {
      skipped.add(finding.filePath);
      continue;
    }
    kept.push(finding);
  }

  return { kept, skippedLargeFiles: [...skipped] };
}
