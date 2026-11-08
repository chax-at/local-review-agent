import { describe, it, expect, vi, beforeEach } from 'vitest';
import LogSink from '@chax-at/log-sink';
import { JiraService, extractTicketKey, parseTicketComments } from '../../src/jira/jira.service';

describe('extractTicketKey', () => {
  it('finds a key in a branch name', () => {
    expect(extractTicketKey(['feature/ABC-123-add-login'], [])).toBe('ABC-123');
  });

  it('uppercases a lowercase branch key (Jira keys are uppercase)', () => {
    expect(extractTicketKey(['feature/abc-123-add-login'], [])).toBe('ABC-123');
  });

  it('searches candidates in order — first hit wins', () => {
    expect(extractTicketKey(['feature/no-key-here', 'DEF-9: fix title'], [])).toBe('DEF-9');
    expect(extractTicketKey(['feature/ABC-1-x', 'DEF-9: fix title'], [])).toBe('ABC-1');
  });

  it('skips null and undefined candidates', () => {
    expect(extractTicketKey([null, undefined, 'ABC-5'], [])).toBe('ABC-5');
  });

  it('returns null when nothing matches', () => {
    expect(extractTicketKey(['feature/just-a-branch', 'plain title'], [])).toBeNull();
  });

  it('honors a project-key allowlist when provided', () => {
    expect(extractTicketKey(['feature/DEF-1-x', 'ABC-2 in title'], ['ABC'])).toBe('ABC-2');
    expect(extractTicketKey(['feature/DEF-1-x'], ['ABC'])).toBeNull();
  });

  it('the allowlist is case-insensitive on both sides', () => {
    expect(extractTicketKey(['feature/abc-3-y'], ['abc'])).toBe('ABC-3');
  });

  it('ignores well-known non-ticket patterns without an allowlist', () => {
    expect(extractTicketKey(['supports ISO-8601 and UTF-8 via SHA-256 per RFC-2616 fixing CVE-2024'], [])).toBeNull();
  });
});

describe('JiraService', () => {
  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  beforeEach(() => {
    mockFetch.mockReset();
  });

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  it('isEnabled only when base URL and token are set', () => {
    expect(new JiraService('https://jira.example.com', 'a@b.c', 'tok', []).isEnabled).toBe(true);
    expect(new JiraService('', 'a@b.c', 'tok', []).isEnabled).toBe(false);
    expect(new JiraService('https://jira.example.com', '', '', []).isEnabled).toBe(false);
  });

  it('fetches the issue with summary+description+comment fields and Basic auth when an email is set', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ fields: { summary: 'Login broken', description: 'Steps' } }));
    const jira = new JiraService('https://jira.example.com/', 'bot@x.at', 'tok', []);
    const ticket = await jira.getTicket('ABC-7');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://jira.example.com/rest/api/2/issue/ABC-7?fields=summary,description,comment');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('bot@x.at:tok').toString('base64')}`);
    expect(ticket).toEqual({ key: 'ABC-7', summary: 'Login broken', description: 'Steps' });
  });

  it('uses Bearer auth when no email is configured (Server/DC PAT)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ fields: { summary: 's', description: null } }));
    const jira = new JiraService('https://jira.example.com', '', 'pat-token', []);
    await jira.getTicket('ABC-7');
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer pat-token');
  });

  it('maps a null description to an empty string', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ fields: { summary: 's', description: null } }));
    const jira = new JiraService('https://jira.example.com', '', 't', []);
    expect(await jira.getTicket('ABC-1')).toEqual({ key: 'ABC-1', summary: 's', description: '' });
  });

  it('returns null on a non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' } as unknown as Response);
    const jira = new JiraService('https://jira.example.com', '', 't', []);
    expect(await jira.getTicket('ABC-404')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network down'));
    const jira = new JiraService('https://jira.example.com', '', 't', []);
    expect(await jira.getTicket('ABC-1')).toBeNull();
  });

  it('returns null without calling fetch when disabled', async () => {
    const jira = new JiraService('', '', '', []);
    expect(await jira.getTicket('ABC-1')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe('ticket-flow calls', () => {
    const bot = { accountId: '712020:bot', displayName: 'Carrot Bot' };

    it('getMyself reads /rest/api/2/myself into an IJiraUser', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ accountId: '712020:bot', displayName: 'Carrot Bot' }));
      const jira = new JiraService('https://j.example.com', 'bot@x.at', 't', []);
      expect(await jira.getMyself()).toEqual(bot);
      expect(mockFetch.mock.calls[0][0]).toBe('https://j.example.com/rest/api/2/myself');
    });

    it('searchIssues uses /search/jql on Cloud and /search on Server, returns keys', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ issues: [{ key: 'ABC-1' }, { key: 'ABC-2' }] }));
      const cloud = new JiraService('https://j.example.com', 'bot@x.at', 't', []);
      expect(await cloud.searchIssues('assignee = currentUser()', 50)).toEqual(['ABC-1', 'ABC-2']);
      const cloudUrl = mockFetch.mock.calls[0][0] as string;
      expect(cloudUrl.startsWith('https://j.example.com/rest/api/2/search/jql?')).toBe(true);
      expect(cloudUrl).toContain('maxResults=50');
      expect(cloudUrl).toContain(encodeURIComponent('assignee = currentUser()'));

      mockFetch.mockResolvedValueOnce(okResponse({ issues: [{ key: 'ABC-3' }] }));
      const server = new JiraService('https://j.example.com', '', 'pat', []);
      expect(await server.searchIssues('x', 10)).toEqual(['ABC-3']);
      expect((mockFetch.mock.calls[1][0] as string).startsWith('https://j.example.com/rest/api/2/search?')).toBe(true);
    });

    it('searchIssues returns [] on HTTP error or throw', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad' } as unknown as Response);
      const jira = new JiraService('https://j.example.com', '', 't', []);
      expect(await jira.searchIssues('x', 5)).toEqual([]);
      mockFetch.mockRejectedValueOnce(new TypeError('down'));
      expect(await jira.searchIssues('x', 5)).toEqual([]);
    });

    it('getIssueForRun expands the changelog and returns comments, reporter, assignee, assignment', async () => {
      mockFetch.mockResolvedValueOnce(
        okResponse({
          key: 'ABC-1',
          fields: {
            summary: 'Do it',
            description: 'Details',
            reporter: { accountId: 'rep', displayName: 'Rep' },
            assignee: { accountId: '712020:bot', displayName: 'Carrot Bot' },
            comment: {
              comments: [
                {
                  id: '5',
                  author: { accountId: 'u', displayName: 'U' },
                  created: '2026-09-01T00:00:00.000+0000',
                  body: 'hi @carrot',
                },
              ],
            },
          },
          changelog: {
            histories: [
              {
                created: '2026-09-01T00:00:00.000+0000',
                author: { accountId: 'lead', displayName: 'Lead' },
                items: [{ field: 'assignee', to: '712020:bot' }],
              },
            ],
          },
        }),
      );
      const jira = new JiraService('https://j.example.com', 'bot@x.at', 't', []);
      const issue = await jira.getIssueForRun('ABC-1', bot);
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://j.example.com/rest/api/2/issue/ABC-1?expand=changelog&fields=summary,description,comment,reporter,assignee',
      );
      expect(issue?.summary).toBe('Do it');
      expect(issue?.reporter).toEqual({ accountId: 'rep', displayName: 'Rep' });
      expect(issue?.assignee).toEqual(bot);
      expect(issue?.comments.map((c) => c.id)).toEqual([5]);
      expect(issue?.assignment).toEqual({
        assignedAt: '2026-09-01T00:00:00.000+0000',
        assignedBy: { accountId: 'lead', displayName: 'Lead' },
      });
    });

    it('addComment posts a plain string body and reports success', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ id: '9' }));
      const jira = new JiraService('https://j.example.com', '', 't', []);
      expect(await jira.addComment('ABC-1', 'hello')).toBe(true);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://j.example.com/rest/api/2/issue/ABC-1/comment');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ body: 'hello' });
    });

    it('assign sends accountId on Cloud and name on Server, null to unassign', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
      const cloud = new JiraService('https://j.example.com', 'bot@x.at', 't', []);
      await cloud.assign('ABC-1', { accountId: 'lead', displayName: 'Lead' });
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ accountId: 'lead' });
      expect(mockFetch.mock.calls[0][1].method).toBe('PUT');

      const server = new JiraService('https://j.example.com', '', 'pat', []);
      await server.assign('ABC-1', { name: 'lead', displayName: 'Lead' });
      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ name: 'lead' });
      await server.assign('ABC-1', null);
      expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({ name: null });
    });

    it('getTransitions lists id+name; transition posts the id', async () => {
      mockFetch.mockResolvedValueOnce(
        okResponse({
          transitions: [
            { id: '31', name: 'In Review' },
            { id: '41', name: 'Done' },
          ],
        }),
      );
      const jira = new JiraService('https://j.example.com', '', 't', []);
      expect(await jira.getTransitions('ABC-1')).toEqual([
        { id: '31', name: 'In Review' },
        { id: '41', name: 'Done' },
      ]);
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
      expect(await jira.transition('ABC-1', '31')).toBe(true);
      const [url, init] = mockFetch.mock.calls[1];
      expect(url).toBe('https://j.example.com/rest/api/2/issue/ABC-1/transitions');
      expect(JSON.parse(init.body)).toEqual({ transition: { id: '31' } });
    });

    it('issueUrl builds the browse link', () => {
      const jira = new JiraService('https://j.example.com/', '', 't', []);
      expect(jira.issueUrl('ABC-1')).toBe('https://j.example.com/browse/ABC-1');
    });

    it('write calls return false when disabled and never call fetch', async () => {
      const jira = new JiraService('', '', '', []);
      expect(await jira.addComment('ABC-1', 'x')).toBe(false);
      expect(await jira.assign('ABC-1', null)).toBe(false);
      expect(await jira.transition('ABC-1', '1')).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('http:// base URLs (undici drops Authorization on the http→https redirect)', () => {
    it('auto-upgrades an http:// *.atlassian.net base URL to https', async () => {
      const warnSpy = vi.spyOn(LogSink, 'warn').mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce(okResponse({ fields: { summary: 's', description: '' } }));
      const jira = new JiraService('http://acme.atlassian.net/', 'a@b.c', 't', []);
      await jira.getTicket('ABC-1');
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://acme.atlassian.net/rest/api/2/issue/ABC-1?fields=summary,description,comment');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('https'), expect.anything());
      warnSpy.mockRestore();
    });

    it('keeps an http:// non-cloud base URL unchanged but warns about the redirect trap', async () => {
      const warnSpy = vi.spyOn(LogSink, 'warn').mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce(okResponse({ fields: { summary: 's', description: '' } }));
      const jira = new JiraService('http://jira.intra.example.com', '', 't', []);
      await jira.getTicket('ABC-1');
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://jira.intra.example.com/rest/api/2/issue/ABC-1?fields=summary,description,comment');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/redirect/i), expect.anything());
      warnSpy.mockRestore();
    });

    it('does not warn for an https base URL or when disabled', () => {
      const warnSpy = vi.spyOn(LogSink, 'warn').mockImplementation(() => {});
      new JiraService('https://acme.atlassian.net/', 'a@b.c', 't', []);
      new JiraService('', '', '', []);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});

describe('parseTicketComments', () => {
  const field = (comments: unknown[], total?: number): unknown => ({ comments, total: total ?? comments.length });

  it('returns the newest comments last, oldest first for reading', () => {
    const parsed = parseTicketComments(
      field([
        { author: { displayName: 'Alice' }, created: '2026-07-01T10:00:00.000+0000', body: 'first' },
        { author: { displayName: 'Bob' }, created: '2026-07-03T10:00:00.000+0000', body: 'third' },
        { author: { displayName: 'Cara' }, created: '2026-07-02T10:00:00.000+0000', body: 'second' },
      ]),
      10,
    );

    expect(parsed.map((c) => c.body)).toEqual(['first', 'second', 'third']);
    expect(parsed[0]).toEqual({ author: 'Alice', created: '2026-07-01', body: 'first' });
  });

  it('keeps only the newest `max` comments', () => {
    const parsed = parseTicketComments(
      field([
        { author: { displayName: 'A' }, created: '2026-07-01T10:00:00.000+0000', body: 'oldest' },
        { author: { displayName: 'B' }, created: '2026-07-02T10:00:00.000+0000', body: 'middle' },
        { author: { displayName: 'C' }, created: '2026-07-03T10:00:00.000+0000', body: 'newest' },
      ]),
      2,
    );

    expect(parsed.map((c) => c.body)).toEqual(['middle', 'newest']);
  });

  it('flattens ADF comment bodies', () => {
    const parsed = parseTicketComments(
      field([
        {
          author: { displayName: 'Alice' },
          created: '2026-07-01T10:00:00.000+0000',
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Scope changed: drop X.' }] }],
          },
        },
      ]),
      10,
    );

    expect(parsed[0].body).toBe('Scope changed: drop X.');
  });

  it('caps a single oversized comment', () => {
    const parsed = parseTicketComments(
      field([{ author: { displayName: 'A' }, created: '2026-07-01T10:00:00.000+0000', body: 'x'.repeat(2000) }]),
      10,
    );

    expect(parsed[0].body.length).toBeLessThanOrEqual(800);
  });

  it('tolerates missing, empty, and malformed comment fields', () => {
    expect(parseTicketComments(undefined, 10)).toEqual([]);
    expect(parseTicketComments({}, 10)).toEqual([]);
    expect(parseTicketComments({ comments: 'nope' }, 10)).toEqual([]);
    expect(parseTicketComments(field([{ body: 'no author, no date' }]), 10)).toEqual([
      { author: 'unknown', created: '', body: 'no author, no date' },
    ]);
  });

  it('drops comments whose body flattens to nothing', () => {
    expect(parseTicketComments(field([{ author: { displayName: 'A' }, created: 'x', body: {} }]), 10)).toEqual([]);
  });
});
