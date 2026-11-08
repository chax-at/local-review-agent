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

  it('stores and reloads ticket state', () => {
    stateService.load();
    stateService.setTicketState('ABC-1', {
      repoKey: 'P/r',
      branch: 'feature/ABC-1-x',
      attempts: 1,
      lastCommentId: 10,
      lastRunAt: '2026-09-11T10:00:00Z',
    });
    stateService.save();

    const fresh = new StateService(tmpDir);
    fresh.load();
    expect(fresh.getTicketState('ABC-1')?.branch).toBe('feature/ABC-1-x');
    expect(fresh.getTicketState('ZZZ-9')).toBeUndefined();
  });

  it('prunes ticket entries older than the window and keeps recent ones', () => {
    stateService.load();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    stateService.setTicketState('ABC-1', { repoKey: 'P/r', attempts: 0, lastCommentId: 0, lastRunAt: old });
    stateService.setTicketState('ABC-2', {
      repoKey: 'P/r',
      attempts: 0,
      lastCommentId: 0,
      lastRunAt: new Date().toISOString(),
    });
    stateService.pruneStale(30);
    expect(stateService.getTicketState('ABC-1')).toBeUndefined();
    expect(stateService.getTicketState('ABC-2')).toBeDefined();
  });
});
