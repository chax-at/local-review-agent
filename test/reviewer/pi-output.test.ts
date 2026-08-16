import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPiOutput, describeOutputReadFailure } from '../../src/reviewer/pi.service';

describe('readPiOutput', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-output-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (content: string): string => {
    const file = path.join(dir, 'lgr-pi-out.log');
    fs.writeFileSync(file, content);
    return file;
  };

  it('returns the whole file when it is below the cap', () => {
    const file = write('{"type":"message_end"}\n');
    expect(readPiOutput(file, 1024)).toBe('{"type":"message_end"}\n');
  });

  it('returns the tail from a line boundary when the file exceeds the cap', () => {
    const file = write('first\nsecond\nthird\n');

    const out = readPiOutput(file, 12);

    expect(out).toContain('third');
    expect(out).not.toContain('first');
    // Never hand back a half line — parsers split on newlines.
    expect(out.startsWith('second') || out.startsWith('third')).toBe(true);
  });

  it('propagates ENOENT so the caller can retry a missing file', () => {
    expect(() => readPiOutput(path.join(dir, 'gone.log'), 1024)).toThrowError(/ENOENT/);
  });
});

describe('describeOutputReadFailure', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fail-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a wiped workspace when the whole mount dir is gone', () => {
    const gone = path.join(dir, 'pi-Ab12Cd');
    const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

    const msg = describeOutputReadFailure(err, gone, path.join(gone, 'lgr-pi-out.log'));

    expect(msg).toMatch(/workspace/i);
    expect(msg).toMatch(/removed|wiped|no longer exists/i);
    expect(msg).toContain(gone);
  });

  it('reports the surviving directory contents when only the log is missing', () => {
    fs.writeFileSync(path.join(dir, 'chunk-0.patch'), 'diff');
    const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

    const msg = describeOutputReadFailure(err, dir, path.join(dir, 'lgr-pi-out.log'));

    expect(msg).toMatch(/never created/i);
    expect(msg).toContain('chunk-0.patch');
  });

  it('reports size and the real error code when the file exists but cannot be read', () => {
    const file = path.join(dir, 'lgr-pi-out.log');
    fs.writeFileSync(file, 'x'.repeat(2048));
    const err = Object.assign(new Error('Cannot create a string longer than 0x1fffffe8 characters'), {
      code: 'ERR_STRING_TOO_LONG',
    });

    const msg = describeOutputReadFailure(err, dir, file);

    expect(msg).toContain('2048');
    expect(msg).toContain('ERR_STRING_TOO_LONG');
    expect(msg).not.toMatch(/never created/i);
  });
});
