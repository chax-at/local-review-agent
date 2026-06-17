import type { IDiffChunk } from '../types';

export function splitDiffByFile(diff: string): IDiffChunk[] {
  const chunks: IDiffChunk[] = [];
  const fileDiffs = diff.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split('\n');

    // Parse file path from "a/path b/path" header
    const headerMatch = lines[0].match(/^a\/(.+?) b\/(.+?)$/);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];
    const isRenamed = oldPath !== newPath;

    const content = `diff --git ${lines.join('\n')}`;
    const lineCount = lines.length;

    chunks.push({
      filePath: newPath,
      oldPath: isRenamed ? oldPath : undefined,
      content,
      lineCount,
    });
  }

  return chunks;
}

export function isDiffTooLarge(diff: string, maxLines: number): boolean {
  const lineCount = diff.split('\n').length;
  return lineCount > maxLines;
}

/**
 * Split a single-file unified diff at @@ hunks so each part is ≤ maxLinesPerPatch (with header repeated).
 * Falls back to line-based slicing if there are no hunks or one hunk is still too large.
 */
export function splitFileDiffAtHunks(fileDiff: string, maxLinesPerPatch: number): string[] {
  const lines = fileDiff.split('\n');
  if (lines.length <= maxLinesPerPatch) return [fileDiff];

  let firstHunk = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('@@')) {
      firstHunk = i;
      break;
    }
  }
  if (firstHunk <= 0) {
    return hardSplitDiffLines(fileDiff, maxLinesPerPatch);
  }

  const header = lines.slice(0, firstHunk).join('\n');
  const headerLineCount = firstHunk;
  if (headerLineCount >= maxLinesPerPatch) {
    return hardSplitDiffLines(fileDiff, maxLinesPerPatch);
  }
  const hunkBlockLines = lines.slice(firstHunk);

  const hunks: string[] = [];
  let hi = 0;
  while (hi < hunkBlockLines.length) {
    if (!hunkBlockLines[hi].startsWith('@@')) {
      hi++;
      continue;
    }
    const start = hi;
    hi++;
    while (hi < hunkBlockLines.length && !hunkBlockLines[hi].startsWith('@@')) hi++;
    hunks.push(hunkBlockLines.slice(start, hi).join('\n'));
  }

  if (hunks.length === 0) {
    return hardSplitDiffLines(fileDiff, maxLinesPerPatch);
  }

  const parts: string[] = [];
  let currentHunks: string[] = [];
  let currentLines = headerLineCount;

  const flush = (): void => {
    if (currentHunks.length === 0) return;
    parts.push(`${header}\n${currentHunks.join('\n')}`);
    currentHunks = [];
    currentLines = headerLineCount;
  };

  for (const h of hunks) {
    const hLines = h.split('\n').length;
    if (hLines > maxLinesPerPatch) {
      flush();
      const hunkBudget = Math.max(1, maxLinesPerPatch - headerLineCount);
      for (const slice of hardSplitDiffLines(h, hunkBudget)) {
        parts.push(`${header}\n${slice}`);
      }
      continue;
    }
    if (currentLines + hLines > maxLinesPerPatch && currentHunks.length > 0) {
      flush();
    }
    currentHunks.push(h);
    currentLines += hLines;
  }
  flush();
  return parts.length > 0 ? parts : hardSplitDiffLines(fileDiff, maxLinesPerPatch);
}

function hardSplitDiffLines(diff: string, maxLines: number): string[] {
  const lines = diff.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    out.push(lines.slice(i, i + maxLines).join('\n'));
  }
  return out;
}

/**
 * Merge consecutive single-file diff strings into fewer patches (each ≤ maxLinesPerPatch) for fewer pi runs
 * inside one Docker container.
 */
export function packDiffPatchesIntoBatches(parts: string[], maxLinesPerPatch: number): string[] {
  if (parts.length === 0) return [];

  const batches: string[] = [];
  let cur: string[] = [];
  let curLines = 0;

  const flush = (): void => {
    if (cur.length === 0) return;
    batches.push(cur.join('\n'));
    cur = [];
    curLines = 0;
  };

  for (const part of parts) {
    const n = part.split('\n').length;
    if (n > maxLinesPerPatch) {
      flush();
      batches.push(part);
      continue;
    }
    if (curLines + n > maxLinesPerPatch && curLines > 0) {
      flush();
    }
    cur.push(part);
    curLines += n;
  }
  flush();
  return batches;
}

export const IGNORED_FILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
];

export function filterIgnoredFiles(chunks: IDiffChunk[]): IDiffChunk[] {
  return chunks.filter((chunk) => {
    const fileName = chunk.filePath.split('/').pop() ?? '';
    return !IGNORED_FILES.includes(fileName);
  });
}

/** True when the path's basename is a known dependency lockfile. */
export function isLockfile(filePath: string): boolean {
  const fileName = filePath.split('/').pop() ?? '';
  return IGNORED_FILES.includes(fileName);
}

/**
 * Returns true only if every new-file line in [startLine, endLine] for the
 * given file is an ADDED (right-side) line in the diff. Returns false if any
 * line in the range is CONTEXT, REMOVED, or absent from the diff.
 *
 * Used to validate proposed suggestion anchors before posting — Bitbucket
 * applicable suggestions only make sense on ADDED lines.
 */
export function isAddedRange(diffLines: string[], filePath: string, startLine: number, endLine: number): boolean {
  if (endLine < startLine) return false;

  const addedLines = new Set<number>();
  let inFile = false;
  let newLine = 0;

  for (const line of diffLines) {
    if (line.startsWith('+++ b/')) {
      inFile = line === `+++ b/${filePath}`;
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (!inFile) continue;

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (line.startsWith('-')) {
      // Removed lines have no new-file line number.
      continue;
    }

    if (line.startsWith('+')) {
      addedLines.add(newLine);
      newLine++;
      continue;
    }

    // Context line — exists on both sides; new-file line counter advances.
    newLine++;
  }

  for (let l = startLine; l <= endLine; l++) {
    if (!addedLines.has(l)) return false;
  }
  return true;
}
