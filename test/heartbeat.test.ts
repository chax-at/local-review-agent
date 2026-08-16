import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHeartbeat } from '../src/heartbeat';

describe('createHeartbeat', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes an ISO timestamp to the given path on every tick', () => {
    const file = path.join(dir, 'heartbeat');
    const tick = createHeartbeat(file);

    tick();
    const first = fs.readFileSync(file, 'utf-8');
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    tick();
    expect(fs.readFileSync(file, 'utf-8')).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('never throws when the path is unwritable', () => {
    const tick = createHeartbeat(path.join(dir, 'missing-dir', 'heartbeat'));
    expect(() => tick()).not.toThrow();
  });
});
