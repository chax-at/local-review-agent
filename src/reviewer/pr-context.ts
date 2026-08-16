export interface IPrInfo {
  id: number;
  title: string;
  description: string;
}

export interface ITicketComment {
  author: string;
  /** Date only (YYYY-MM-DD), or '' when unknown. */
  created: string;
  body: string;
}

export interface ITicketInfo {
  key: string;
  summary: string;
  description: string;
  /** Most recent ticket comments, oldest-first. Absent or empty renders no discussion section. */
  comments?: ITicketComment[];
}

/** Cap per section so a novel-length PR body or ticket can't inflate every reviewer prompt. */
const MAX_SECTION_CHARS = 4000;

/**
 * Assemble the pr-context.md blob describing the PR's intent: title +
 * description, followed by the originating Jira ticket when one was resolved —
 * its summary, description, and the tail of its discussion. Every body is
 * human-authored (untrusted) input: capped here, and only ever informing
 * judgment since reviewers stay tool-less. Returns null when there is nothing
 * to say.
 */
export function buildPrInfoBlob(pr: IPrInfo | null, ticket: ITicketInfo | null): string | null {
  const parts: string[] = [];
  if (pr) {
    parts.push(`# PR #${pr.id}: ${pr.title}`.trim());
    if (pr.description.trim()) parts.push(pr.description.trim().slice(0, MAX_SECTION_CHARS));
  }
  if (ticket) {
    parts.push(`## Ticket ${ticket.key}: ${ticket.summary}`.trim());
    if (ticket.description.trim()) parts.push(ticket.description.trim().slice(0, MAX_SECTION_CHARS));

    // The discussion is where scope tends to move after the description was
    // written, so it is worth its own section — capped as a whole.
    const discussion = (ticket.comments ?? [])
      .map((c) => `- ${c.author}${c.created ? ` (${c.created})` : ''}: ${c.body.trim()}`)
      .join('\n');
    if (discussion.trim()) {
      parts.push(
        `## Ticket discussion (most recent comments, oldest first):\n${discussion.slice(0, MAX_SECTION_CHARS)}`,
      );
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}
