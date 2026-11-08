import { describe, it, expect } from 'vitest';
import { decideTicketMode, findNewMention, newestCommentId } from '../../src/tickets/ticket-mode';

const bot = { accountId: 'bot', displayName: 'Carrot' };
const human = { accountId: 'h', displayName: 'H' };
const c = (id: number, text: string, author = human) => ({ id, author, created: '', text, body: text });

describe('findNewMention / newestCommentId', () => {
  it('returns the newest human comment above the watermark that mentions the bot', () => {
    const comments = [c(1, '@carrot old'), c(2, 'no'), c(3, '@carrot go'), c(4, 'thanks')];
    expect(findNewMention(comments, 1, bot)?.id).toBe(3);
    expect(findNewMention(comments, 3, bot)).toBeNull();
  });

  it('ignores comments written by the bot even when they contain @carrot', () => {
    const comments = [c(5, 'Mention @carrot to continue.', bot)];
    expect(findNewMention(comments, 0, bot)).toBeNull();
  });

  it('newestCommentId is 0 for no comments', () => {
    expect(newestCommentId([])).toBe(0);
    expect(newestCommentId([c(2, 'a'), c(9, 'b')])).toBe(9);
  });
});

describe('decideTicketMode', () => {
  const assignment = { assignedAt: '2026-09-10T10:00:00.000+0000', assignedBy: human };

  it('continue when a new mention exists, regardless of assignment time', () => {
    const mode = decideTicketMode({
      issue: { comments: [c(7, '@carrot add tests')], assignment },
      state: { repoKey: 'P/r', attempts: 0, lastCommentId: 3, lastRunAt: '2026-09-11T00:00:00.000Z' },
      bot,
    });
    expect(mode.kind).toBe('continue');
  });

  it('fresh when there is no state', () => {
    expect(decideTicketMode({ issue: { comments: [], assignment }, state: undefined, bot }).kind).toBe('fresh');
  });

  it('fresh when the assignment is newer than the last run', () => {
    const mode = decideTicketMode({
      issue: { comments: [], assignment },
      state: { repoKey: 'P/r', attempts: 0, lastCommentId: 0, lastRunAt: '2026-09-09T00:00:00.000Z' },
      bot,
    });
    expect(mode.kind).toBe('fresh');
  });

  it('fresh when the changelog shows no assignment (treated as newer than any run)', () => {
    const mode = decideTicketMode({
      issue: { comments: [], assignment: null },
      state: { repoKey: 'P/r', attempts: 0, lastCommentId: 0, lastRunAt: '2026-09-11T00:00:00.000Z' },
      bot,
    });
    expect(mode.kind).toBe('fresh');
  });

  it('fresh when the ticket has a failed attempt, even though the last run is newer than the assignment', () => {
    const mode = decideTicketMode({
      issue: { comments: [], assignment },
      state: { repoKey: 'P/r', attempts: 1, lastCommentId: 0, lastRunAt: '2026-09-11T00:00:00.000Z' },
      bot,
    });
    expect(mode.kind).toBe('fresh');
  });

  it('skip when the last run is newer than the assignment and no new mention exists', () => {
    const mode = decideTicketMode({
      issue: { comments: [c(1, '@carrot', bot)], assignment },
      state: { repoKey: 'P/r', attempts: 0, lastCommentId: 1, lastRunAt: '2026-09-11T00:00:00.000Z' },
      bot,
    });
    expect(mode.kind).toBe('skip');
  });
});
