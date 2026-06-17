import * as fs from 'fs';
import * as path from 'path';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IBambooState, IBambooBuildState, IAuditPrTracker } from '../types';

export class BambooStateService {
  private readonly statePath: string;
  private state: IBambooState;

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.statePath = path.join(dataDir, 'bamboo-state.json');
    this.state = { builds: {} };
  }

  public load(): IBambooState {
    const tmpPath = `${this.statePath}.tmp`;
    if (fs.existsSync(tmpPath)) {
      LogSink.warn('Cleaning up orphaned bamboo state temp file', TraceTags.STATE);
      fs.unlinkSync(tmpPath);
    }

    if (fs.existsSync(this.statePath)) {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      this.state = JSON.parse(raw);
      LogSink.debug(`Bamboo state loaded: ${Object.keys(this.state.builds).length} builds tracked`, TraceTags.STATE);
    } else {
      this.state = { builds: {} };
      LogSink.debug('No existing bamboo state file, starting fresh', TraceTags.STATE);
    }
    return this.state;
  }

  public save(): void {
    const tmpPath = `${this.statePath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmpPath, this.statePath);
    } catch (err) {
      LogSink.error(`Failed to save bamboo state to ${this.statePath}: ${err}`, TraceTags.STATE);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore cleanup failure */
      }
    }
  }

  public getBuildState(buildKey: string): IBambooBuildState | undefined {
    return this.state.builds[buildKey];
  }

  public setBuildState(buildKey: string, buildState: IBambooBuildState): void {
    this.state.builds[buildKey] = buildState;
  }

  public pruneStale(pruneDays: number): void {
    const cutoff = Date.now() - pruneDays * 24 * 60 * 60 * 1000;
    const before = Object.keys(this.state.builds).length;
    for (const [key, build] of Object.entries(this.state.builds)) {
      if (new Date(build.checkedAt).getTime() < cutoff) {
        delete this.state.builds[key];
      }
    }
    const pruned = before - Object.keys(this.state.builds).length;
    if (pruned > 0) {
      LogSink.debug(`Pruned ${pruned} stale builds (older than ${pruneDays} days)`, TraceTags.STATE);
    }
  }

  public getAuditPr(key: string): IAuditPrTracker | undefined {
    return this.state.auditPrs?.[key];
  }

  public setAuditPr(key: string, tracker: IAuditPrTracker): void {
    if (!this.state.auditPrs) this.state.auditPrs = {};
    this.state.auditPrs[key] = tracker;
  }

  public removeAuditPr(key: string): void {
    if (this.state.auditPrs) {
      delete this.state.auditPrs[key];
    }
  }

  public getLastScheduledAudit(key: string): string | undefined {
    return this.state.scheduledAudits?.[key];
  }

  public setLastScheduledAudit(key: string, isoDate: string): void {
    if (!this.state.scheduledAudits) this.state.scheduledAudits = {};
    this.state.scheduledAudits[key] = isoDate;
  }

  public getState(): IBambooState {
    return this.state;
  }
}
