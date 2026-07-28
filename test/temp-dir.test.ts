import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pruneTempRoot } from '../src/temp-dir';

const STALE_AFTER_MS = 10 * 60 * 1000;

describe('pruneTempRoot', () => {
  let root: string;
  const now = 1_700_000_000_000;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'carrot-prune-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Create a sibling instance dir holding one file, aged `ageMs` in the past. */
  const seed = (name: string, ageMs: number): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lgr-pi-out.log'), 'in-flight review output');
    const stamp = (now - ageMs) / 1000;
    fs.utimesSync(dir, stamp, stamp);
    return dir;
  };

  it('leaves a live sibling instance dir untouched', () => {
    // The bug: a second bot process wiped this dir mid-review, so the running
    // container's output file vanished from the host's view.
    const live = seed('4242', 6 * 60 * 1000);

    pruneTempRoot(root, path.join(root, '111'), {
      isAlive: (pid) => pid === 4242,
      now,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(fs.existsSync(path.join(live, 'lgr-pi-out.log'))).toBe(true);
  });

  it('removes a stale dir whose owning process is gone', () => {
    const dead = seed('999', 30 * 60 * 1000);

    const removed = pruneTempRoot(root, path.join(root, '111'), {
      isAlive: () => false,
      now,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(fs.existsSync(dead)).toBe(false);
    expect(removed).toContain(dead);
  });

  it('keeps a recently touched dir even when no process claims it (pid-reuse guard)', () => {
    const recent = seed('999', 30 * 1000);

    pruneTempRoot(root, path.join(root, '111'), {
      isAlive: () => false,
      now,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(fs.existsSync(recent)).toBe(true);
  });

  it('prunes stale legacy dirs from the flat layout', () => {
    const legacy = seed('pi-Ab12Cd', 30 * 60 * 1000);

    pruneTempRoot(root, path.join(root, '111'), {
      isAlive: () => true,
      now,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('recreates its own dir empty', () => {
    const own = seed('111', 0);

    pruneTempRoot(root, own, { isAlive: () => true, now, staleAfterMs: STALE_AFTER_MS });

    expect(fs.existsSync(own)).toBe(true);
    expect(fs.readdirSync(own)).toEqual([]);
  });

  it('creates root and own dir when the root does not exist yet', () => {
    const missingRoot = path.join(root, 'nested', 'carrot');
    const own = path.join(missingRoot, '111');

    pruneTempRoot(missingRoot, own, { isAlive: () => true, now, staleAfterMs: STALE_AFTER_MS });

    expect(fs.existsSync(own)).toBe(true);
  });
});
