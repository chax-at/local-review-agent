import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';

export interface IJiraComment {
  author: string;
  /** Date only (YYYY-MM-DD); '' when Jira sent nothing parseable. */
  created: string;
  body: string;
}

export interface IJiraTicket {
  key: string;
  summary: string;
  description: string;
  /** Newest comments, oldest-first for reading. Absent when the ticket has none. */
  comments?: IJiraComment[];
}

/** How many of the ticket's most recent comments to carry into the review. */
export const MAX_TICKET_COMMENTS = 10;

/** Per-comment cap so one essay can't crowd out the rest of the discussion. */
const MAX_COMMENT_CHARS = 800;

/**
 * Prefixes that match the ticket-key pattern but are almost never Jira keys.
 * Only consulted when no project-key allowlist is configured — an explicit
 * allowlist always wins.
 */
const NON_TICKET_PREFIXES = new Set([
  'ISO',
  'UTF',
  'SHA',
  'RFC',
  'CVE',
  'MD',
  'TLS',
  'SSL',
  'HTTP',
  'HTTPS',
  'ECMA',
  'IEEE',
  'OAUTH',
]);

/**
 * Find the first Jira ticket key in the given candidates (checked in order —
 * pass them most-reliable first, e.g. [sourceBranch, prTitle, prDescription]).
 * Matching is case-insensitive (branch names are often lowercase) and the
 * returned key is uppercased. With a non-empty `projectKeys` allowlist, only
 * those projects match; without one, well-known non-ticket patterns
 * (ISO-8601, SHA-256, ...) are ignored.
 */
export function extractTicketKey(candidates: Array<string | null | undefined>, projectKeys: string[]): string | null {
  const allow = projectKeys.map((k) => k.trim().toUpperCase()).filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const match of candidate.matchAll(/\b([A-Za-z][A-Za-z0-9]+-\d+)\b/g)) {
      const key = match[1].toUpperCase();
      const prefix = key.slice(0, key.indexOf('-'));
      const accepted = allow.length > 0 ? allow.includes(prefix) : !NON_TICKET_PREFIXES.has(prefix);
      if (accepted) return key;
    }
  }
  return null;
}

/**
 * Jira issues live on a different API v2/v3 shape per deployment; some
 * instances hand back an ADF document instead of the v2 plain string. Flatten
 * whatever arrives into plain text, defensively.
 */
function extractPlainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: unknown; content?: unknown; type?: unknown };
    if (typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) {
      n.content.forEach(walk);
      if (n.type === 'paragraph') parts.push('\n');
    }
  };
  walk(value);
  return parts.join('').trim();
}

/**
 * Read the `comment` field of an issue into the newest {@link MAX_TICKET_COMMENTS}
 * comments, oldest-first so the result reads as a conversation.
 *
 * The ticket description states the original intent; the discussion is where
 * scope actually changes ("we decided not to do X", "also needs Y"), which is
 * exactly what a reviewer needs to judge whether a diff matches its intent.
 *
 * Defensive by design: deployments differ (v2 plain strings vs ADF documents),
 * the embedded field may be a page rather than the full list, and `author` or
 * `created` can be missing on some instances. Anything unparseable is skipped
 * rather than throwing.
 */
export function parseTicketComments(field: unknown, max: number): IJiraComment[] {
  const raw = (field as { comments?: unknown } | null | undefined)?.comments;
  if (!Array.isArray(raw)) return [];

  const parsed: Array<IJiraComment & { sortKey: number }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as { author?: { displayName?: unknown }; created?: unknown; body?: unknown };

    const body = extractPlainText(c.body).replace(/\s+/g, ' ').trim().slice(0, MAX_COMMENT_CHARS);
    if (!body) continue;

    const createdRaw = typeof c.created === 'string' ? c.created : '';
    const timestamp = Date.parse(createdRaw);
    parsed.push({
      author: typeof c.author?.displayName === 'string' && c.author.displayName ? c.author.displayName : 'unknown',
      created: Number.isNaN(timestamp) ? '' : createdRaw.slice(0, 10),
      body,
      // Undated comments sort oldest so dated ones keep their real order.
      sortKey: Number.isNaN(timestamp) ? 0 : timestamp,
    });
  }

  // Sort ascending, keep the newest `max`, and hand them back oldest-first.
  parsed.sort((a, b) => a.sortKey - b.sortKey);
  return parsed.slice(-max).map(({ author, created, body }) => ({ author, created, body }));
}

/**
 * Minimal read-only Jira client used to pull the originating ticket of a PR
 * into the review context. Disabled (all calls return null) unless a base URL
 * and token are configured. Auth style follows the credentials: with an email
 * it sends Basic `email:token` (Jira Cloud API tokens), without one a Bearer
 * PAT (Jira Server / Data Center).
 *
 * Never throws — a Jira outage or a bad key must cost the review nothing but a
 * missing ticket section.
 */
/**
 * Node's fetch (undici) strips the Authorization header when a redirect
 * crosses origins — and http→https is a cross-origin hop. An `http://` cloud
 * URL therefore reaches Jira anonymously, which answers 404 even for existing
 * tickets. Atlassian Cloud is https-only, so upgrading `*.atlassian.net` is
 * always correct; other hosts might genuinely serve plain http (Server/DC on
 * an internal network), so those only get a warning.
 */
function normalizeBaseUrl(baseUrl: string): string {
  if (!/^http:\/\//i.test(baseUrl.trim())) return baseUrl;
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
  if (host.toLowerCase().endsWith('.atlassian.net')) {
    const upgraded = baseUrl.trim().replace(/^http:/i, 'https:');
    LogSink.warn(`Jira: base URL ${baseUrl} is Atlassian Cloud — using ${upgraded} (https) instead`, TraceTags.JIRA);
    return upgraded;
  }
  LogSink.warn(
    `Jira: base URL ${baseUrl} uses http — if the server redirects to https, the Authorization header is dropped and requests fail (typically with 404)`,
    TraceTags.JIRA,
  );
  return baseUrl;
}

export class JiraService {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly email: string,
    private readonly apiToken: string,
    /** Optional allowlist of Jira project keys used by extractTicketKey callers. */
    public readonly projectKeys: string[],
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  public get isEnabled(): boolean {
    return this.baseUrl.trim() !== '' && this.apiToken.trim() !== '';
  }

  public async getTicket(key: string): Promise<IJiraTicket | null> {
    if (!this.isEnabled) return null;
    const url = `${this.baseUrl.replace(/\/$/, '')}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,comment`;
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: this.authHeader() },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        LogSink.warn(`Jira: fetching ${key} failed with HTTP ${response.status}`, TraceTags.JIRA);
        return null;
      }
      const raw = (await response.json()) as {
        fields?: { summary?: unknown; description?: unknown; comment?: unknown };
      };
      const comments = parseTicketComments(raw.fields?.comment, MAX_TICKET_COMMENTS);
      const total = (raw.fields?.comment as { total?: unknown } | undefined)?.total;
      if (typeof total === 'number' && total > comments.length) {
        LogSink.debug(
          `Jira: ${key} has ${total} comment(s); carrying the ${comments.length} most recent into the review`,
          TraceTags.JIRA,
        );
      }
      return {
        key,
        summary: typeof raw.fields?.summary === 'string' ? raw.fields.summary : '',
        description: extractPlainText(raw.fields?.description),
        comments: comments.length > 0 ? comments : undefined,
      };
    } catch (err) {
      LogSink.warn(`Jira: fetching ${key} threw: ${err}`, TraceTags.JIRA);
      return null;
    }
  }

  private authHeader(): string {
    return this.email
      ? `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}`
      : `Bearer ${this.apiToken}`;
  }
}
