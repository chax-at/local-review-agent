import * as fs from 'fs';
import * as path from 'path';

/** Options for {@link pruneTempRoot} — injectable so the logic is unit-testable. */
export interface IPruneTempRootOptions {
  /** True when a process with this pid is still running. */
  isAlive: (pid: number) => boolean;
  /** Current time in ms. */
  now: number;
  /** Only unclaimed dirs untouched for at least this long are removed. */
  staleAfterMs: number;
}

/** A dir is only pruned once it is both unclaimed and cold for this long. */
export const TEMP_DIR_STALE_AFTER_MS = 10 * 60 * 1000;

/** True when a process with this pid exists (EPERM means alive but foreign). */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reset this process's own temp dir and reclaim disk from dead instances,
 * without ever touching a dir another live instance is working in.
 *
 * The temp root is shared machine-wide (`$TMPDIR/carrot`), so a blanket wipe
 * deletes the Docker workspace of any concurrently running instance — the
 * container keeps writing to the unlinked inode and exits 0, leaving the host
 * with no output file at all. Each instance therefore owns `<root>/<pid>` and
 * only ever wipes that subtree.
 *
 * @returns the sibling dirs that were removed, for logging.
 */
export function pruneTempRoot(root: string, ownDir: string, opts: IPruneTempRootOptions): string[] {
  fs.mkdirSync(root, { recursive: true });

  // Fresh workspace for this cycle.
  fs.rmSync(ownDir, { recursive: true, force: true });
  fs.mkdirSync(ownDir, { recursive: true });

  const removed: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const dir = path.join(root, entry);
    if (path.resolve(dir) === path.resolve(ownDir)) continue;

    // A numeric name is an instance dir; anything else is a leftover from the
    // old flat layout and has no owner to check.
    const pid = /^\d+$/.test(entry) ? Number(entry) : NaN;
    if (Number.isInteger(pid) && opts.isAlive(pid)) continue;

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (opts.now - mtimeMs < opts.staleAfterMs) continue;

    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Another instance may be tearing it down concurrently — leave it.
    }
  }

  return removed;
}
