import * as os from 'os';
import * as path from 'path';

/** Branch prefixes created by the bot. Used to filter out bot PRs from processing. */
export const BOT_BRANCH_PREFIXES = ['carrot/'];

/** Machine-wide temp root shared by every bot instance on this host. */
export const BOT_TEMP_ROOT = path.join(os.tmpdir(), 'carrot');

/**
 * Temp directory for this process's temp files. Cleaned at the start of each
 * poll cycle — scoped per pid so a second instance's cleanup can never delete
 * the Docker workspace of a review this instance is running.
 */
export const BOT_TEMP_DIR = path.join(BOT_TEMP_ROOT, String(process.pid));

/** Check if a comment is from the bot by author slug */
export const isBotComment = (authorSlug: string, botUsername: string): boolean => authorSlug === botUsername;

/** Check if text mentions the bot — matches @carrot and @agent carrot */
export const isBotMention = (text: string, botUsername: string): boolean =>
  text.includes(`@${botUsername}`) || text.toLowerCase().includes('@agent carrot');

/** Generate a timestamp string for branch names: YYYY-MM-DDTHH-mm */
export function branchTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
}
