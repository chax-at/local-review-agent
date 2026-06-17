import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BambooStateService } from '../../src/bamboo/bamboo.state.service';

describe('BambooStateService', () => {
  let tmpDir: string;
  let service: BambooStateService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-state-test-'));
    service = new BambooStateService(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty state when no file exists', () => {
    service.load();
    expect(service.getBuildState('KEY-123')).toBeUndefined();
  });

  it('persists and loads state', () => {
    service.load();
    service.setBuildState('KEY-123', {
      checkedAt: '2026-03-22T10:00:00Z',
      state: 'Failed',
      auditIssue: true,
      status: 'audit_detected',
    });
    service.save();

    const service2 = new BambooStateService(tmpDir);
    service2.load();
    const state = service2.getBuildState('KEY-123');
    expect(state).toBeDefined();
    expect(state!.status).toBe('audit_detected');
  });

  it('uses atomic writes (no .tmp file after save)', () => {
    service.load();
    service.setBuildState('KEY-1', { checkedAt: '', state: 'OK', auditIssue: false, status: 'checked_ok' });
    service.save();
    expect(fs.existsSync(path.join(tmpDir, 'bamboo-state.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'bamboo-state.json'))).toBe(true);
  });

  it('cleans up orphaned .tmp files on load', () => {
    fs.writeFileSync(path.join(tmpDir, 'bamboo-state.json.tmp'), 'stale');
    service.load();
    expect(fs.existsSync(path.join(tmpDir, 'bamboo-state.json.tmp'))).toBe(false);
  });

  it('prunes stale entries older than pruneDays', () => {
    service.load();
    const old = new Date();
    old.setDate(old.getDate() - 31);
    service.setBuildState('OLD-1', { checkedAt: old.toISOString(), state: 'OK', auditIssue: false, status: 'checked_ok' });
    service.setBuildState('NEW-1', { checkedAt: new Date().toISOString(), state: 'OK', auditIssue: false, status: 'checked_ok' });
    service.pruneStale(30);
    expect(service.getBuildState('OLD-1')).toBeUndefined();
    expect(service.getBuildState('NEW-1')).toBeDefined();
  });
});
