import * as fs from 'fs';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from './log/tags';

/**
 * Build the liveness tick shared by the poller and the reviewer.
 *
 * The container HEALTHCHECK reads this file and fails when it goes stale, so it
 * has to be touched at every point where the process is still healthy but about
 * to be busy for a while. A poll cycle is not a useful granularity: reviews run
 * pi through a synchronous `spawnSync`, which blocks the event loop (so no timer
 * can tick for us), and a cycle spans several of those back to back. The
 * reviewer therefore ticks between runs.
 *
 * Never throws — a failed heartbeat write must not abort a review.
 */
export function createHeartbeat(filePath: string): () => void {
  return () => {
    try {
      fs.writeFileSync(filePath, new Date().toISOString());
    } catch (err) {
      LogSink.warn(`Failed to write heartbeat: ${err}`, TraceTags.POLLER);
    }
  };
}
