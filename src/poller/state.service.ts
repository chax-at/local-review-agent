import * as fs from 'fs';
import * as path from 'path';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IAppState, IPrState } from '../types';

export class StateService {
  private readonly statePath: string;
  private state: IAppState;

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.statePath = path.join(dataDir, 'state.json');
    this.state = { repos: {} };
  }

  public load(): IAppState {
    // Clean up orphaned temp files
    const tmpPath = `${this.statePath}.tmp`;
    if (fs.existsSync(tmpPath)) {
      LogSink.warn('Cleaning up orphaned state temp file', TraceTags.STATE);
      fs.unlinkSync(tmpPath);
    }

    if (fs.existsSync(this.statePath)) {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      this.state = JSON.parse(raw);
      LogSink.debug(`State loaded: ${Object.keys(this.state.repos).length} repos tracked`, TraceTags.STATE);
    } else {
      this.state = { repos: {} };
      LogSink.debug('No existing state file, starting fresh', TraceTags.STATE);
    }
    return this.state;
  }

  public save(): void {
    const tmpPath = `${this.statePath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmpPath, this.statePath);
    } catch (err) {
      LogSink.error(`Failed to save state to ${this.statePath}: ${err}`, TraceTags.STATE);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore cleanup failure */
      }
    }
  }

  public getPrState(repoKey: string, prId: string): IPrState | undefined {
    return this.state.repos[repoKey]?.pullRequests[prId];
  }

  public setPrState(repoKey: string, prId: string, prState: IPrState): void {
    if (this.state.repos[repoKey] === undefined) {
      this.state.repos[repoKey] = { pullRequests: {} };
    }
    const repoState = this.state.repos[repoKey] ?? { pullRequests: {} };
    repoState.pullRequests[prId] = prState;
    this.state.repos[repoKey] = repoState;
  }

  public getState(): IAppState {
    return this.state;
  }

  public pruneStale(pruneDays: number): void {
    const cutoff = Date.now() - pruneDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [repoKey, repoState] of Object.entries(this.state.repos)) {
      if (!repoState) continue;
      for (const [prId, prState] of Object.entries(repoState.pullRequests)) {
        if (!prState) continue;
        if (new Date(prState.lastCheckedAt).getTime() < cutoff) {
          delete repoState.pullRequests[prId];
          pruned++;
        }
      }
      if (Object.keys(repoState.pullRequests).length === 0) {
        delete this.state.repos[repoKey];
      }
    }
    if (pruned > 0) {
      LogSink.debug(`Pruned ${pruned} stale PR state entries (older than ${pruneDays} days)`, TraceTags.STATE);
    }
  }
}
