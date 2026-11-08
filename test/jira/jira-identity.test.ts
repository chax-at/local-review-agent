import { describe, it, expect } from 'vitest';
import {
  parseJiraUser,
  isSameJiraUser,
  parseRawComments,
  commentMentionsBot,
  findLatestAssignmentToBot,
  type IJiraUser,
} from '../../src/jira/jira-identity';

const botCloud: IJiraUser = { accountId: '712020:bot', displayName: 'Carrot Bot' };
const botServer: IJiraUser = { name: 'carrot', displayName: 'carrot' };

describe('parseJiraUser / isSameJiraUser', () => {
  it('reads accountId, name and displayName; returns null for garbage', () => {
    expect(parseJiraUser({ accountId: 'a1', displayName: 'A' })).toEqual({ accountId: 'a1', displayName: 'A' });
    expect(parseJiraUser({ name: 'bob', displayName: 'Bob' })).toEqual({ name: 'bob', displayName: 'Bob' });
    expect(parseJiraUser(null)).toBeNull();
    expect(parseJiraUser('x')).toBeNull();
  });

  it('matches on accountId first, then on name', () => {
    expect(isSameJiraUser({ accountId: 'a1', displayName: 'x' }, { accountId: 'a1', displayName: 'y' })).toBe(true);
    expect(isSameJiraUser({ name: 'carrot', displayName: 'x' }, { name: 'carrot', displayName: 'y' })).toBe(true);
    expect(isSameJiraUser({ accountId: 'a1', displayName: 'x' }, { accountId: 'a2', displayName: 'x' })).toBe(false);
    expect(isSameJiraUser(null, botCloud)).toBe(false);
  });
});

describe('parseRawComments', () => {
  it('reads id, author, created, plain text and keeps the raw body, sorted by id', () => {
    const field = {
      comments: [
        { id: '12', author: { accountId: 'u1', displayName: 'U' }, created: '2026-09-01T10:00:00.000+0000', body: 'second' },
        { id: '7', author: { name: 'bob', displayName: 'Bob' }, created: '2026-08-01T10:00:00.000+0000', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] } },
        { id: 'not-a-number', body: 'skipped' },
      ],
    };
    const parsed = parseRawComments(field);
    expect(parsed.map((c) => c.id)).toEqual([7, 12]);
    expect(parsed[0].text).toBe('first');
    expect(parsed[0].author).toEqual({ name: 'bob', displayName: 'Bob' });
    expect(parsed[1].text).toBe('second');
    expect(parsed[1].created).toBe('2026-09-01T10:00:00.000+0000');
  });

  it('returns [] for a missing or malformed field', () => {
    expect(parseRawComments(undefined)).toEqual([]);
    expect(parseRawComments({ comments: 'no' })).toEqual([]);
  });

  it('yields author: { displayName: "unknown" } when author is missing or malformed', () => {
    const field = {
      comments: [
        { id: '1', created: '2026-09-01T10:00:00.000+0000', body: 'no author' },
        { id: '2', author: null, created: '2026-09-01T10:00:00.000+0000', body: 'null author' },
        { id: '3', author: 'garbage', created: '2026-09-01T10:00:00.000+0000', body: 'invalid author' },
      ],
    };
    const parsed = parseRawComments(field);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].author).toEqual({ displayName: 'unknown' });
    expect(parsed[1].author).toEqual({ displayName: 'unknown' });
    expect(parsed[2].author).toEqual({ displayName: 'unknown' });
  });
});

describe('commentMentionsBot', () => {
  const base = { id: 1, created: '', author: { accountId: 'u1', displayName: 'U' } };

  it('matches the literal text @carrot case-insensitively', () => {
    expect(commentMentionsBot({ ...base, text: 'Hey @Carrot please continue', body: 'x' }, botCloud)).toBe(true);
  });

  it('matches @<displayName>', () => {
    expect(commentMentionsBot({ ...base, text: 'cc @Carrot Bot', body: 'x' }, botCloud)).toBe(true);
  });

  it('matches an ADF mention node with the bot accountId', () => {
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: '712020:bot', text: '@Carrot Bot' } }] }] };
    expect(commentMentionsBot({ ...base, text: 'plain text without handle', body }, botCloud)).toBe(true);
  });

  it('matches the Server wiki-markup mention [~carrot]', () => {
    expect(commentMentionsBot({ ...base, text: '[~carrot] go', body: '[~carrot] go' }, botServer)).toBe(true);
  });

  it('does not match an unrelated comment', () => {
    expect(commentMentionsBot({ ...base, text: 'nothing here', body: 'nothing here' }, botCloud)).toBe(false);
  });

  it('does not match @ alone when bot.displayName is empty, but still matches @carrot', () => {
    const emptyDisplayNameBot: IJiraUser = { accountId: 'x', displayName: '' };
    expect(commentMentionsBot({ ...base, text: 'something @ here', body: 'x' }, emptyDisplayNameBot)).toBe(false);
    expect(commentMentionsBot({ ...base, text: 'do @carrot now', body: 'x' }, emptyDisplayNameBot)).toBe(true);
  });
});

describe('findLatestAssignmentToBot', () => {
  const changelog = {
    histories: [
      {
        created: '2026-09-01T09:00:00.000+0000',
        author: { accountId: 'lead', displayName: 'Lead' },
        items: [{ field: 'assignee', to: '712020:bot' }],
      },
      {
        created: '2026-09-02T09:00:00.000+0000',
        author: { accountId: 'dev', displayName: 'Dev' },
        items: [{ field: 'status', to: '3' }],
      },
      {
        created: '2026-09-03T09:00:00.000+0000',
        author: { accountId: 'pm', displayName: 'PM' },
        items: [{ field: 'assignee', to: '712020:bot' }],
      },
    ],
  };

  it('returns the newest assignment to the bot with its author', () => {
    expect(findLatestAssignmentToBot(changelog, botCloud)).toEqual({
      assignedAt: '2026-09-03T09:00:00.000+0000',
      assignedBy: { accountId: 'pm', displayName: 'PM' },
    });
  });

  it('matches Server changelogs where "to" is the username', () => {
    const serverLog = { histories: [{ created: '2026-09-03T09:00:00.000+0000', author: { name: 'lead', displayName: 'Lead' }, items: [{ field: 'assignee', to: 'carrot' }] }] };
    expect(findLatestAssignmentToBot(serverLog, botServer)?.assignedBy).toEqual({ name: 'lead', displayName: 'Lead' });
  });

  it('returns null when the bot never appears as assignee', () => {
    expect(findLatestAssignmentToBot({ histories: [] }, botCloud)).toBeNull();
    expect(findLatestAssignmentToBot(undefined, botCloud)).toBeNull();
  });

  it('handles garbage or missing created timestamps without throwing, prefers valid timestamps', () => {
    const mixedLog = {
      histories: [
        {
          created: 'not-a-date',
          author: { accountId: 'a1', displayName: 'A' },
          items: [{ field: 'assignee', to: '712020:bot' }],
        },
        {
          created: '',
          author: { accountId: 'a2', displayName: 'B' },
          items: [{ field: 'assignee', to: '712020:bot' }],
        },
        {
          created: '2026-09-05T09:00:00.000+0000',
          author: { accountId: 'a3', displayName: 'C' },
          items: [{ field: 'assignee', to: '712020:bot' }],
        },
      ],
    };
    const result = findLatestAssignmentToBot(mixedLog, botCloud);
    expect(result).not.toBeNull();
    expect(result?.assignedBy?.displayName).toBe('C');
    expect(result?.assignedAt).toBe('2026-09-05T09:00:00.000+0000');

    const onlyGarbageLog = {
      histories: [
        {
          created: 'bad-date',
          author: { accountId: 'solo', displayName: 'Solo' },
          items: [{ field: 'assignee', to: '712020:bot' }],
        },
      ],
    };
    const soloResult = findLatestAssignmentToBot(onlyGarbageLog, botCloud);
    expect(soloResult?.assignedAt).toBe('bad-date');
    expect(soloResult?.assignedBy?.displayName).toBe('Solo');
  });
});
