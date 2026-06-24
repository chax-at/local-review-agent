import { describe, it, expect } from 'vitest';
import {
  splitDiffByFile,
  isDiffTooLarge,
  packDiffPatchesIntoBatches,
  splitFileDiffAtHunks,
  isAddedRange,
  extractAddedLines,
  isLockfile,
} from '../../src/reviewer/diff.utils';

const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 import { bar } from './bar';
+import { baz } from './baz';

 export function foo() {
diff --git a/src/bar.ts b/src/bar.ts
index 1111111..2222222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -5,3 +5,3 @@
-export function old() {
+export function updated() {
   return true;
`;

const renameDiff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
`;

describe('splitDiffByFile', () => {
  it('should split a multi-file diff into chunks', () => {
    const chunks = splitDiffByFile(sampleDiff);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].filePath).toBe('src/foo.ts');
    expect(chunks[1].filePath).toBe('src/bar.ts');
  });

  it('should detect renamed files', () => {
    const chunks = splitDiffByFile(renameDiff);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].filePath).toBe('new-name.ts');
    expect(chunks[0].oldPath).toBe('old-name.ts');
  });
});

describe('isDiffTooLarge', () => {
  it('should return true if line count exceeds max', () => {
    const bigDiff = 'line\n'.repeat(6000);
    expect(isDiffTooLarge(bigDiff, 5000)).toBe(true);
  });

  it('should return false if within limit', () => {
    expect(isDiffTooLarge(sampleDiff, 5000)).toBe(false);
  });
});

describe('packDiffPatchesIntoBatches', () => {
  it('merges small single-file patches up to line cap', () => {
    const a = 'diff --git a/x b/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
    const b = 'diff --git a/y b/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n';
    const batches = packDiffPatchesIntoBatches([a, b], 20);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain('diff --git a/x');
    expect(batches[0]).toContain('diff --git a/y');
  });

  it('starts a new batch when adding would exceed cap', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`).join('\n');
    const a = `diff --git a/x b/x\n${lines(15)}`;
    const b = `diff --git a/y b/y\n${lines(15)}`;
    const batches = packDiffPatchesIntoBatches([a, b], 20);
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('splitFileDiffAtHunks', () => {
  it('returns one part when under cap', () => {
    expect(splitFileDiffAtHunks(sampleDiff, 5000)).toEqual([sampleDiff]);
  });

  it('splits at @@ boundaries when file exceeds cap', () => {
    const twoHunks = `diff --git a/huge b/huge
--- a/huge
+++ b/huge
@@ -1,2 +1,2 @@
 a
 b
@@ -10,2 +10,2 @@
 c
 d`;
    const parts = splitFileDiffAtHunks(twoHunks, 8);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const p of parts) {
      expect(p.split('\n').length).toBeLessThanOrEqual(8);
    }
  });
});

describe('isAddedRange', () => {
  // A small, focused diff: file foo.ts, hunk starting at new-file line 10,
  // adding lines 10/11/12, then a context line at 13, then adding 14.
  const diffLines = [
    'diff --git a/foo.ts b/foo.ts',
    '--- a/foo.ts',
    '+++ b/foo.ts',
    '@@ -10,2 +10,5 @@',
    '+const a = 1;',
    '+const b = 2;',
    '+const c = 3;',
    ' const x = 0;',
    '+const d = 4;',
  ];

  it('returns true when every line in the range is ADDED', () => {
    expect(isAddedRange(diffLines, 'foo.ts', 10, 12)).toBe(true);
  });

  it('returns true for a single-line ADDED range', () => {
    expect(isAddedRange(diffLines, 'foo.ts', 14, 14)).toBe(true);
  });

  it('returns false when the range contains a CONTEXT line', () => {
    // 10..14 spans 10/11/12 (ADDED), 13 (CONTEXT), 14 (ADDED) → not all ADDED
    expect(isAddedRange(diffLines, 'foo.ts', 10, 14)).toBe(false);
  });

  it('returns false when only the start line is ADDED but end line is context', () => {
    // 12..13 spans 12 (ADDED), 13 (CONTEXT) → not all ADDED
    expect(isAddedRange(diffLines, 'foo.ts', 12, 13)).toBe(false);
  });

  it('returns false for a file path not in the diff', () => {
    expect(isAddedRange(diffLines, 'other.ts', 10, 12)).toBe(false);
  });

  it('returns false when start > end', () => {
    expect(isAddedRange(diffLines, 'foo.ts', 12, 10)).toBe(false);
  });

  it('returns false when a line is missing from the diff entirely', () => {
    // line 99 is past the hunk → unknown → not ADDED
    expect(isAddedRange(diffLines, 'foo.ts', 99, 99)).toBe(false);
  });
});

describe('extractAddedLines', () => {
  const diffLines = [
    'diff --git a/foo.ts b/foo.ts',
    '--- a/foo.ts',
    '+++ b/foo.ts',
    '@@ -10,2 +10,5 @@',
    '+const a = 1;',
    '+const b = 2;',
    '+const c = 3;',
    ' const x = 0;',
    '+const d = 4;',
  ];

  it('returns each ADDED line with its new-file number and the + stripped', () => {
    expect(extractAddedLines(diffLines, 'foo.ts')).toEqual([
      { line: 10, content: 'const a = 1;' },
      { line: 11, content: 'const b = 2;' },
      { line: 12, content: 'const c = 3;' },
      { line: 14, content: 'const d = 4;' },
    ]);
  });

  it('ignores context and removed lines', () => {
    const withRemoval = [
      'diff --git a/bar.ts b/bar.ts',
      '--- a/bar.ts',
      '+++ b/bar.ts',
      '@@ -5,3 +5,3 @@',
      ' const keep = 0;',
      '-const old = 1;',
      '+const neu = 1;',
      ' const tail = 2;',
    ];
    expect(extractAddedLines(withRemoval, 'bar.ts')).toEqual([{ line: 6, content: 'const neu = 1;' }]);
  });

  it('spans multiple hunks in the same file', () => {
    const twoHunks = [
      'diff --git a/baz.ts b/baz.ts',
      '--- a/baz.ts',
      '+++ b/baz.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
      '@@ -10,1 +11,2 @@',
      ' const c = 3;',
      '+const d = 4;',
    ];
    expect(extractAddedLines(twoHunks, 'baz.ts')).toEqual([
      { line: 2, content: 'const b = 2;' },
      { line: 12, content: 'const d = 4;' },
    ]);
  });

  it('returns an empty array for a file not in the diff', () => {
    expect(extractAddedLines(diffLines, 'other.ts')).toEqual([]);
  });

  it('preserves an empty added line (blank insertion)', () => {
    const blank = ['--- a/q.ts', '+++ b/q.ts', '@@ -1,0 +1,2 @@', '+', '+const a = 1;'];
    expect(extractAddedLines(blank, 'q.ts')).toEqual([
      { line: 1, content: '' },
      { line: 2, content: 'const a = 1;' },
    ]);
  });
});

describe('isLockfile', () => {
  it('matches known lockfile basenames regardless of directory', () => {
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('frontend/yarn.lock')).toBe(true);
    expect(isLockfile('a/b/pnpm-lock.yaml')).toBe(true);
  });

  it('does not match ordinary source files', () => {
    expect(isLockfile('src/app.ts')).toBe(false);
    expect(isLockfile('lock.ts')).toBe(false);
  });
});
