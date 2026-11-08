import { describe, it, expect } from 'vitest';
import { buildTicketMarkdown, ticketRequestText, MAX_PROMPT_COMMENTS } from '../../src/tickets/ticket-prompt';

const comment = (id: number, text: string) => ({
  id,
  author: { accountId: `u${id}`, displayName: `User ${id}` },
  created: `2026-09-${String(id).padStart(2, '0')}T10:00:00.000+0000`,
  text,
  body: text,
});

describe('buildTicketMarkdown', () => {
  it('renders key, summary, full description, comments oldest-first, and rules files', () => {
    const md = buildTicketMarkdown({
      key: 'ABC-1',
      summary: 'Add retry',
      description: 'A'.repeat(2000),
      comments: [comment(1, 'first'), comment(2, 'second')],
      rules: [{ fileName: 'CLAUDE.md', content: '# Rules\nUse I prefix.' }],
    });
    expect(md).toContain('# ABC-1: Add retry');
    expect(md).toContain('A'.repeat(2000));
    expect(md.indexOf('first')).toBeLessThan(md.indexOf('second'));
    expect(md).toContain('User 1 (2026-09-01)');
    expect(md).toContain('## Rules: CLAUDE.md');
    expect(md).toContain('Use I prefix.');
    expect(md).not.toContain('## Instruction');
  });

  it('keeps only the last MAX_PROMPT_COMMENTS comments', () => {
    const comments = Array.from({ length: MAX_PROMPT_COMMENTS + 3 }, (_, i) => comment(i + 1, `c${i + 1}`));
    const md = buildTicketMarkdown({ key: 'ABC-1', summary: 's', description: '', comments, rules: [] });
    expect(md).not.toContain('c1\n');
    expect(md).toContain(`c${MAX_PROMPT_COMMENTS + 3}`);
  });

  it('adds the continue-mode instruction block', () => {
    const md = buildTicketMarkdown({
      key: 'ABC-1',
      summary: 's',
      description: '',
      comments: [],
      instruction: { author: 'Lead', text: 'also add tests' },
      rules: [],
    });
    expect(md).toContain('## Instruction from Lead');
    expect(md).toContain('also add tests');
  });

  it('omits empty sections', () => {
    const md = buildTicketMarkdown({ key: 'ABC-1', summary: 's', description: '', comments: [], rules: [] });
    expect(md).not.toContain('## Comments');
    expect(md).not.toContain('## Rules');
    expect(md).toContain('(no description)');
  });

  it('renders full output with exact structure and block ordering', () => {
    const md = buildTicketMarkdown({
      key: 'ABC-1',
      summary: 'Add retry',
      description: 'Do this.',
      comments: [comment(1, 'comment text')],
      instruction: { author: 'Lead', text: 'Add tests.' },
      rules: [{ fileName: 'CLAUDE.md', content: '# Rules' }],
    });
    const expected = `# ABC-1: Add retry

## Description

Do this.

## Comments (oldest first)

- User 1 (2026-09-01): comment text

## Instruction from Lead

Add tests.

## Rules: CLAUDE.md

# Rules
`;
    expect(md).toBe(expected);
  });

  it('renders comment with empty text as a bullet line with empty content', () => {
    const md = buildTicketMarkdown({
      key: 'ABC-1',
      summary: 's',
      description: '',
      comments: [{ id: 1, author: { displayName: 'User 1' }, created: '2026-09-01T10:00:00.000+0000', text: '', body: '' }],
      rules: [],
    });
    expect(md).toContain('- User 1 (2026-09-01): ');
  });

  it('omits rules entry when content is whitespace only', () => {
    const md = buildTicketMarkdown({
      key: 'ABC-1',
      summary: 's',
      description: '',
      comments: [],
      rules: [{ fileName: 'CLAUDE.md', content: '   \n' }],
    });
    expect(md).not.toContain('## Rules');
  });

  it('renders comment with empty created as unknown date', () => {
    const md = buildTicketMarkdown({
      key: 'ABC-1',
      summary: 's',
      description: '',
      comments: [{ id: 1, author: { displayName: 'User 1' }, created: '', text: 'text', body: 'text' }],
      rules: [],
    });
    expect(md).toContain('(unknown date)');
  });
});

describe('ticketRequestText', () => {
  it('joins key, summary and description', () => {
    expect(ticketRequestText({ key: 'ABC-1', summary: 'Add retry', description: 'Because.' })).toBe('ABC-1: Add retry\n\nBecause.');
  });
});
