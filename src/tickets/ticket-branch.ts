/** Every ticket branch starts with this. It is not a bot prefix: the PR gets a normal review. */
export const TICKET_BRANCH_PREFIX = 'feature/';

/** Cap on the summary slug so branch names stay readable in Bitbucket. */
export const MAX_SLUG_LENGTH = 40;

/**
 * Turn a ticket summary into a branch slug: lowercase, every run of
 * non-alphanumerics becomes one dash, no leading/trailing dashes, cut at
 * MAX_SLUG_LENGTH. An empty result becomes "ticket" so the branch name is
 * still well-formed.
 */
export function slugifySummary(summary: string): string {
  const base = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  return cut || 'ticket';
}

/** `feature/ABC-123-<slug>` for the given ticket key and summary. */
export function ticketBranchName(key: string, summary: string): string {
  return `${TICKET_BRANCH_PREFIX}${key.toUpperCase()}-${slugifySummary(summary)}`;
}

/**
 * Find a branch that already belongs to this ticket. Matches on the
 * `feature/KEY-` prefix rather than the exact slug: a summary edit after the
 * first run changes the slug, but the ticket's branch is still the same one.
 */
export function findExistingTicketBranch(key: string, branches: string[]): string | null {
  const prefix = `${TICKET_BRANCH_PREFIX}${key.toUpperCase()}-`;
  const match = branches.find((b) => b.toUpperCase().startsWith(prefix.toUpperCase()));
  return match ?? null;
}
