// test/provider/bitbucket-cloud/cloud.mappers.test.ts
import { describe, it, expect } from 'vitest';
import {
  toPullRequestCloud,
  toCommentCloud,
  toBuildStatusCloud,
  toRepoCloud,
  cloudUserId,
} from '../../../src/provider/bitbucket-cloud/cloud.mappers';

describe('cloud.mappers.cloudUserId', () => {
  it('prefers account_id over nickname over display_name', () => {
    expect(cloudUserId({ account_id: 'a', nickname: 'n', display_name: 'd' })).toBe('a');
    expect(cloudUserId({ nickname: 'n', display_name: 'd' })).toBe('n');
    expect(cloudUserId({ display_name: 'd' })).toBe('d');
    expect(cloudUserId({})).toBe('');
  });
});

describe('cloud.mappers.toPullRequestCloud', () => {
  it('flattens Cloud PR shape', () => {
    const out = toPullRequestCloud({
      id: 5,
      title: 'feat: x',
      state: 'OPEN',
      draft: false,
      created_on: '2026-05-15T10:00:00Z',
      updated_on: '2026-05-15T12:00:00Z',
      source: { branch: { name: 'feat' }, commit: { hash: 'abc' } },
      destination: { branch: { name: 'main' } },
      author: { account_id: 'alice' },
    } as any);
    expect(out).toEqual({
      id: 5,
      title: 'feat: x',
      draft: false,
      isOpen: true,
      createdAt: Date.parse('2026-05-15T10:00:00Z'),
      updatedAt: Date.parse('2026-05-15T12:00:00Z'),
      sourceBranch: 'feat',
      sourceCommit: 'abc',
      targetBranch: 'main',
      authorUsername: 'alice',
    });
  });

  it('isOpen is false for non-OPEN states', () => {
    const out = toPullRequestCloud({
      id: 1, title: 't', state: 'MERGED',
      created_on: '2026-01-01T00:00:00Z', updated_on: '2026-01-01T00:00:00Z',
      source: { branch: { name: 'a' }, commit: { hash: 'h' } },
      destination: { branch: { name: 'b' } },
      author: { account_id: 'u' },
    } as any);
    expect(out.isOpen).toBe(false);
  });
});

describe('cloud.mappers.toCommentCloud', () => {
  it('extracts inline anchor with `to` as the line', () => {
    const out = toCommentCloud({
      id: 7,
      content: { raw: 'note' },
      user: { account_id: 'alice' },
      inline: { path: 'src/x.ts', to: 12 },
      created_on: '2026-01-01T00:00:00Z',
    } as any, []);
    expect(out.anchor).toEqual({ path: 'src/x.ts', line: 12 });
  });

  it('falls back to `from` when `to` is absent', () => {
    const out = toCommentCloud({
      id: 7,
      content: { raw: 'note' },
      user: { account_id: 'a' },
      inline: { path: 'src/x.ts', from: 9 },
      created_on: '2026-01-01T00:00:00Z',
    } as any, []);
    expect(out.anchor).toEqual({ path: 'src/x.ts', line: 9 });
  });

  it('emits undefined anchor for non-inline comments', () => {
    const out = toCommentCloud({
      id: 7,
      content: { raw: 'general' },
      user: { account_id: 'a' },
      created_on: '2026-01-01T00:00:00Z',
    } as any, []);
    expect(out.anchor).toBe(undefined);
  });

  it('attaches direct replies passed in as siblings', () => {
    const replies = [
      { id: 8, content: { raw: 'ack' }, user: { account_id: 'b' }, parent: { id: 7 }, created_on: '' },
      { id: 9, content: { raw: 'x' }, user: { account_id: 'c' }, parent: { id: 99 }, created_on: '' },
    ] as any;
    const out = toCommentCloud({
      id: 7,
      content: { raw: 'note' },
      user: { account_id: 'a' },
      created_on: '',
    } as any, replies);
    expect(out.replies).toEqual([{ id: 8, text: 'ack', authorUsername: 'b' }]);
  });
});

describe('cloud.mappers.toBuildStatusCloud', () => {
  it('lowercases and maps STOPPED to failed', () => {
    expect(toBuildStatusCloud({ state: 'SUCCESSFUL', key: 'k', url: 'u' } as any).state).toBe('successful');
    expect(toBuildStatusCloud({ state: 'FAILED', key: 'k', url: 'u' } as any).state).toBe('failed');
    expect(toBuildStatusCloud({ state: 'INPROGRESS', key: 'k', url: 'u' } as any).state).toBe('in_progress');
    expect(toBuildStatusCloud({ state: 'STOPPED', key: 'k', url: 'u' } as any).state).toBe('failed');
  });
});

describe('cloud.mappers.toRepoCloud', () => {
  it('reads slug and uses workspace as projectKey', () => {
    expect(toRepoCloud({ slug: 'api', full_name: 'ws/api' } as any, 'ws')).toEqual({
      slug: 'api',
      projectKey: 'ws',
    });
  });
});
