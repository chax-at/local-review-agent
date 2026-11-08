/**
 * A Jira user as either deployment reports it. Cloud identifies people by
 * `accountId`; Server / Data Center by `name` (the username). `displayName`
 * is present on both and is only used for text.
 */
export interface IJiraUser {
  accountId?: string;
  name?: string;
  displayName: string;
}

export interface IJiraRawComment {
  id: number;
  author: IJiraUser;
  /** ISO string as Jira sent it, or '' when missing. */
  created: string;
  /** Flattened plain text of the body. */
  text: string;
  /** Raw body: a string (v2 / Server) or an ADF document (Cloud). */
  body: unknown;
}

/**
 * Jira issues live on a different API v2/v3 shape per deployment; some
 * instances hand back an ADF document instead of the v2 plain string. Flatten
 * whatever arrives into plain text, defensively.
 */
export function extractPlainText(value: unknown): string {
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

export function parseJiraUser(raw: unknown): IJiraUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as { accountId?: unknown; name?: unknown; displayName?: unknown };
  const user: IJiraUser = { displayName: typeof u.displayName === 'string' ? u.displayName : '' };
  if (typeof u.accountId === 'string' && u.accountId) user.accountId = u.accountId;
  if (typeof u.name === 'string' && u.name) user.name = u.name;
  if (!user.accountId && !user.name) return null;
  return user;
}

/** Same person: equal accountId (Cloud) or, when neither side has one, equal name (Server). */
export function isSameJiraUser(a: IJiraUser | null | undefined, b: IJiraUser | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.accountId && b.accountId) return a.accountId === b.accountId;
  if (a.name && b.name) return a.name === b.name;
  return false;
}

/** Read `fields.comment` into comments with ids, ascending by id. Unparseable entries are skipped. */
export function parseRawComments(field: unknown): IJiraRawComment[] {
  const raw = (field as { comments?: unknown } | null | undefined)?.comments;
  if (!Array.isArray(raw)) return [];
  const out: IJiraRawComment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as { id?: unknown; author?: unknown; created?: unknown; body?: unknown };
    const id = Number(c.id);
    if (!Number.isFinite(id)) continue;
    out.push({
      id,
      author: parseJiraUser(c.author) ?? { displayName: 'unknown' },
      created: typeof c.created === 'string' ? c.created : '',
      text: extractPlainText(c.body),
      body: c.body,
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

/** True when an ADF document contains a `mention` node whose `attrs.id` is the given account id. */
function adfMentions(body: unknown, accountId: string): boolean {
  if (!body || typeof body !== 'object') return false;
  const n = body as { type?: unknown; attrs?: { id?: unknown }; content?: unknown };
  if (n.type === 'mention' && n.attrs?.id === accountId) return true;
  if (Array.isArray(n.content)) return n.content.some((child) => adfMentions(child, accountId));
  return false;
}

/**
 * Whether a comment addresses the bot: the literal `@carrot`, `@<displayName>`,
 * the Server wiki mention `[~<name>]`, or a Cloud ADF mention node with the
 * bot's account id.
 */
export function commentMentionsBot(comment: IJiraRawComment, bot: IJiraUser): boolean {
  const text = comment.text.toLowerCase();
  if (text.includes('@carrot')) return true;
  if (bot.displayName && text.includes(`@${bot.displayName.toLowerCase()}`)) return true;
  if (bot.name && text.includes(`[~${bot.name.toLowerCase()}]`)) return true;
  if (bot.accountId && adfMentions(comment.body, bot.accountId)) return true;
  return false;
}

/**
 * Newest changelog entry that set the assignee to the bot. Its `created` is
 * the assignment time (compared with the ticket state's `lastRunAt`); its
 * `author` is the person to hand the ticket back to.
 */
export function findLatestAssignmentToBot(
  changelog: unknown,
  bot: IJiraUser,
): { assignedAt: string; assignedBy: IJiraUser | null } | null {
  const histories = (changelog as { histories?: unknown } | null | undefined)?.histories;
  if (!Array.isArray(histories)) return null;
  const botId = bot.accountId ?? bot.name;
  if (!botId) return null;

  let best: { assignedAt: string; assignedBy: IJiraUser | null; sortKey: number } | null = null;
  for (const entry of histories) {
    if (!entry || typeof entry !== 'object') continue;
    const h = entry as { created?: unknown; author?: unknown; items?: unknown };
    if (!Array.isArray(h.items)) continue;
    const toBot = h.items.some((item) => {
      const i = item as { field?: unknown; to?: unknown };
      return i.field === 'assignee' && i.to === botId;
    });
    if (!toBot) continue;
    const created = typeof h.created === 'string' ? h.created : '';
    const sortKey = Date.parse(created);
    const key = Number.isNaN(sortKey) ? 0 : sortKey;
    if (!best || key >= best.sortKey) {
      best = { assignedAt: created, assignedBy: parseJiraUser(h.author), sortKey: key };
    }
  }
  if (!best) return null;
  return { assignedAt: best.assignedAt, assignedBy: best.assignedBy };
}
