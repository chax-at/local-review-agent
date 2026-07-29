import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pruneDumpDir } from '../../src/reviewer/pi.service';

describe('pruneDumpDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dumps-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Dumps are named by ISO timestamp, so lexical order is chronological. */
  const seed = (name: string, bytes: number): string => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, 'x'.repeat(bytes));
    return file;
  };

  it('keeps only the newest maxFiles dumps', () => {
    const files = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'].map((n) => seed(n, 10));

    pruneDumpDir(dir, 2, 1024);

    expect(fs.existsSync(files[0])).toBe(false);
    expect(fs.existsSync(files[1])).toBe(false);
    expect(fs.existsSync(files[2])).toBe(true);
    expect(fs.existsSync(files[3])).toBe(true);
  });

  it('evicts oldest dumps until the total byte budget is met', () => {
    const old = seed('2026-01-01', 600);
    const mid = seed('2026-01-02', 300);
    const newest = seed('2026-01-03', 300);

    pruneDumpDir(dir, 10, 700);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(mid)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
  });

  it('always keeps the newest dump even when it alone exceeds the budget', () => {
    const huge = seed('2026-01-02', 5000);

    pruneDumpDir(dir, 5, 1000);

    expect(fs.existsSync(huge)).toBe(true);
  });

  it('does not throw when the directory is missing', () => {
    expect(() => pruneDumpDir(path.join(dir, 'nope'), 5, 1000)).not.toThrow();
  });
});
