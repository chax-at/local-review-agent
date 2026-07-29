import { describe, it, expect } from 'vitest';
import { buildPrInfoBlob } from '../../src/reviewer/pr-context';

describe('buildPrInfoBlob', () => {
  it('returns null when there is neither PR info nor a ticket', () => {
    expect(buildPrInfoBlob(null, null)).toBeNull();
  });

  it('renders the PR title as a heading', () => {
    const blob = buildPrInfoBlob({ id: 12, title: 'Fix the flux capacitor', description: '' }, null);
    expect(blob).toContain('# PR #12: Fix the flux capacitor');
  });

  it('includes the PR description as the body', () => {
    const blob = buildPrInfoBlob({ id: 3, title: 't', description: 'We replace X with Y because Z.' }, null);
    expect(blob).toContain('We replace X with Y because Z.');
  });

  it('caps an oversized PR description at 4000 chars', () => {
    const blob = buildPrInfoBlob({ id: 3, title: 't', description: 'D'.repeat(5000) }, null)!;
    expect(blob).toContain('D'.repeat(4000));
    expect(blob).not.toContain('D'.repeat(4001));
  });

  it('renders a ticket section with key and summary', () => {
    const blob = buildPrInfoBlob(null, { key: 'ABC-7', summary: 'Users cannot log in', description: 'Steps: ...' });
    expect(blob).toContain('## Ticket ABC-7: Users cannot log in');
    expect(blob).toContain('Steps: ...');
  });

  it('caps an oversized ticket description at 4000 chars', () => {
    const blob = buildPrInfoBlob(null, { key: 'ABC-7', summary: 's', description: 'T'.repeat(5000) })!;
    expect(blob).toContain('T'.repeat(4000));
    expect(blob).not.toContain('T'.repeat(4001));
  });

  it('renders PR first, then the ticket', () => {
    const blob = buildPrInfoBlob(
      { id: 1, title: 'pr title', description: 'pr body' },
      { key: 'ABC-1', summary: 'ticket summary', description: 'ticket body' },
    )!;
    expect(blob.indexOf('pr title')).toBeLessThan(blob.indexOf('ABC-1'));
    expect(blob).toContain('pr body');
    expect(blob).toContain('ticket body');
  });
});

describe('buildPrInfoBlob ticket discussion', () => {
  const ticket = (comments?: Array<{ author: string; created: string; body: string }>) => ({
    key: 'ABC-7',
    summary: 'Users cannot log in',
    description: 'Steps: ...',
    comments,
  });

  it('renders comments chronologically under a discussion heading', () => {
    const blob = buildPrInfoBlob(
      null,
      ticket([
        { author: 'Alice', created: '2026-07-01', body: 'Scope: drop the X migration.' },
        { author: 'Bob', created: '2026-07-02', body: 'Agreed, also needs a feature flag.' },
      ]),
    )!;

    expect(blob).toContain('## Ticket discussion');
    expect(blob).toContain('- Alice (2026-07-01): Scope: drop the X migration.');
    expect(blob).toContain('- Bob (2026-07-02): Agreed, also needs a feature flag.');
    expect(blob.indexOf('Alice')).toBeLessThan(blob.indexOf('Bob'));
  });

  it('omits the discussion section when the ticket has no comments', () => {
    expect(buildPrInfoBlob(null, ticket())).not.toContain('Ticket discussion');
    expect(buildPrInfoBlob(null, ticket([]))).not.toContain('Ticket discussion');
  });

  it('caps the whole discussion section at 4000 chars', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      author: `A${i}`,
      created: '2026-07-01',
      body: 'y'.repeat(500),
    }));
    const blob = buildPrInfoBlob(null, ticket(many))!;
    const section = blob.slice(blob.indexOf('## Ticket discussion'));
    expect(section.length).toBeLessThanOrEqual(4100);
  });

  it('renders a comment without a date without an empty parenthesis', () => {
    const blob = buildPrInfoBlob(null, ticket([{ author: 'Alice', created: '', body: 'no date' }]))!;
    expect(blob).toContain('- Alice: no date');
  });
});
