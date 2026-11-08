import { describe, it, expect } from 'vitest';
import { slugifySummary, ticketBranchName, findExistingTicketBranch } from '../../src/tickets/ticket-branch';

describe('slugifySummary', () => {
  it('lowercases and replaces runs of non-alphanumerics with one dash', () => {
    expect(slugifySummary('Add retry to the S3 upload client!')).toBe('add-retry-to-the-s3-upload-client');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugifySummary('  --Fix: login (again)--  ')).toBe('fix-login-again');
  });

  it('cuts at 40 characters and removes a trailing dash left by the cut', () => {
    const slug = slugifySummary('one two three four five six seven eight nine ten eleven');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toBe('one-two-three-four-five-six-seven-eight');
  });

  it('falls back to "ticket" for an empty summary', () => {
    expect(slugifySummary('!!!')).toBe('ticket');
    expect(slugifySummary('')).toBe('ticket');
  });
});

describe('ticketBranchName', () => {
  it('builds feature/KEY-slug with an uppercased key', () => {
    expect(ticketBranchName('abc-123', 'Add retry to the S3 upload client!')).toBe(
      'feature/ABC-123-add-retry-to-the-s3-upload-client',
    );
  });
});

describe('findExistingTicketBranch', () => {
  it('matches any branch with the feature/KEY- prefix, not only the exact slug', () => {
    const branches = ['main', 'feature/ABC-123-old-summary', 'feature/ABC-1234-other'];
    expect(findExistingTicketBranch('ABC-123', branches)).toBe('feature/ABC-123-old-summary');
  });

  it('does not match a longer key that shares the digits prefix', () => {
    expect(findExistingTicketBranch('ABC-123', ['feature/ABC-1234-other'])).toBeNull();
  });

  it('is case-insensitive on the key', () => {
    expect(findExistingTicketBranch('abc-123', ['feature/ABC-123-x'])).toBe('feature/ABC-123-x');
  });

  it('returns null when nothing matches', () => {
    expect(findExistingTicketBranch('ABC-123', ['main', 'carrot/fix-1-x'])).toBeNull();
  });
});
