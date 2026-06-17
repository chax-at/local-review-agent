import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateService } from '../../src/poller/state.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('StateService', () => {
  let tmpDir: string;
  let stateService: StateService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
    stateService = new StateService(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should initialize with empty state if file does not exist', () => {
    const state = stateService.load();
    expect(state).toEqual({ repos: {} });
  });

  it('should save and load state', () => {
    stateService.setPrState('PROJ/repo', '1', {
      lastReviewedCommit: 'abc123',
      lastCheckedAt: '2026-03-21T10:00:00Z',
      lastActivityId: 100,
    });
    stateService.save();

    const freshService = new StateService(tmpDir);
    const state = freshService.load();
    expect(state.repos['PROJ/repo'].pullRequests['1'].lastReviewedCommit).toBe('abc123');
  });

  it('should write atomically (temp file + rename)', () => {
    stateService.setPrState('PROJ/repo', '1', {
      lastReviewedCommit: 'abc',
      lastCheckedAt: '2026-03-21T10:00:00Z',
      lastActivityId: 0,
    });
    stateService.save();

    // No leftover .tmp files
    const files = fs.readdirSync(tmpDir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    expect(files).toContain('state.json');
  });

  it('should clean up orphaned temp files on load', () => {
    fs.writeFileSync(path.join(tmpDir, 'state.json.tmp'), '{}');
    stateService.load();
    const files = fs.readdirSync(tmpDir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });
});
