import { describe, it, expect } from 'vitest';
import {
  toPullRequest,
  toComment,
  toActivity,
  toBuildStatus,
  toProject,
  toRepo,
  toServerInlineCommentPayload,
} from '../../../src/provider/bitbucket-server/server.mappers';
import type {
  IBitbucketPullRequest,
  IBitbucketActivity,
  IBitbucketBuildStatus,
  IBitbucketComment,
} from '../../../src/provider/bitbucket-server/server.types';

describe('server.mappers.toPullRequest', () => {
  it('flattens wire PR into neutral shape', () => {
    const wire: IBitbucketPullRequest = {
      id: 42,
      title: 'Fix thing',
      state: 'OPEN',
      open: true,
      draft: false,
      createdDate: 1700000000000,
      updatedDate: 1700001000000,
      version: 3,
      fromRef: {
        id: 'refs/heads/feat',
        displayId: 'feat',
        latestCommit: 'abc123',
        repository: { slug: 'r', project: { key: 'P' } },
      },
      toRef: {
        id: 'refs/heads/main',
        displayId: 'main',
        latestCommit: 'def456',
        repository: { slug: 'r', project: { key: 'P' } },
      },
      author: { user: { slug: 'alice' } },
    };

    expect(toPullRequest(wire)).toEqual({
      id: 42,
      title: 'Fix thing',
      draft: false,
      isOpen: true,
      createdAt: 1700000000000,
      updatedAt: 1700001000000,
      sourceBranch: 'feat',
      sourceCommit: 'abc123',
      targetBranch: 'main',
      authorUsername: 'alice',
    });
  });

  it('treats missing draft as false and missing dates as null', () => {
    const wire: IBitbucketPullRequest = {
      id: 1,
      title: 't',
      state: 'OPEN',
      open: true,
      fromRef: {
        id: 'refs/heads/x',
        displayId: 'x',
        latestCommit: 'h',
        repository: { slug: 'r', project: { key: 'P' } },
      },
      toRef: {
        id: 'refs/heads/m',
        displayId: 'm',
        latestCommit: 'h2',
        repository: { slug: 'r', project: { key: 'P' } },
      },
      author: { user: { slug: 'a' } },
    };

    const out = toPullRequest(wire);
    expect(out.draft).toBe(false);
    expect(out.createdAt).toBe(null);
    expect(out.updatedAt).toBe(null);
    expect(out.isOpen).toBe(true);
  });
});

describe('server.mappers.toComment', () => {
  it('extracts anchor and flattens replies', () => {
    const wire = {
      id: 5,
      text: 'looks good',
      author: { slug: 'bob' },
      anchor: { line: 10, lineType: 'ADDED', path: 'src/x.ts' },
      comments: [
        { id: 6, text: 'thanks', author: { slug: 'alice' } },
        { id: 7, text: 'ack', author: { slug: 'carol' } },
      ],
    };
    const out = toComment(wire as any);
    expect(out).toEqual({
      id: 5,
      text: 'looks good',
      authorUsername: 'bob',
      anchor: { path: 'src/x.ts', line: 10 },
      replies: [
        { id: 6, text: 'thanks', authorUsername: 'alice' },
        { id: 7, text: 'ack', authorUsername: 'carol' },
      ],
    });
  });

  it('handles comments without anchor or replies', () => {
    const out = toComment({ id: 1, text: 't', author: { slug: 'a' } } as any);
    expect(out.anchor).toBe(undefined);
    expect(out.replies).toEqual([]);
  });
});

describe('server.mappers.toActivity', () => {
  it('returns id and comment if present', () => {
    const out = toActivity({
      id: 99,
      action: 'COMMENTED',
      comment: { id: 1, text: 't', author: { slug: 'a' } },
    } as any);
    expect(out).toEqual({ id: 99, comment: { id: 1, text: 't', authorUsername: 'a', replies: [], anchor: undefined } });
  });

  it('returns id without comment for non-comment activities', () => {
    const out = toActivity({ id: 100, action: 'APPROVED' } as any);
    expect(out).toEqual({ id: 100, comment: undefined });
  });
});

describe('server.mappers.toBuildStatus', () => {
  it('lowercases SUCCESSFUL/FAILED/INPROGRESS', () => {
    expect(toBuildStatus({ state: 'SUCCESSFUL', key: 'k', url: 'u' } as any).state).toBe('successful');
    expect(toBuildStatus({ state: 'FAILED', key: 'k', url: 'u' } as any).state).toBe('failed');
    expect(toBuildStatus({ state: 'INPROGRESS', key: 'k', url: 'u' } as any).state).toBe('in_progress');
  });
});

describe('server.mappers.toProject', () => {
  it('maps key and name', () => {
    expect(toProject({ key: 'INFRA', name: 'Infrastructure' })).toEqual({
      key: 'INFRA',
      name: 'Infrastructure',
    });
  });

  it('preserves an undefined name', () => {
    expect(toProject({ key: 'X' } as any)).toEqual({ key: 'X', name: undefined });
  });
});

describe('server.mappers.toRepo', () => {
  it('maps slug and lifts project.key to projectKey', () => {
    expect(toRepo({ slug: 'api', project: { key: 'INFRA' } })).toEqual({
      slug: 'api',
      projectKey: 'INFRA',
    });
  });
});

describe('server.mappers.toServerInlineCommentPayload', () => {
  it('builds anchor with uppercased lineType and embeds srcPath for renames', () => {
    const payload = toServerInlineCommentPayload({
      text: 'note',
      path: 'src/new.ts',
      line: 5,
      lineKind: 'added',
      oldPath: 'src/old.ts',
    });
    expect(payload).toEqual({
      text: 'note',
      anchor: {
        path: 'src/new.ts',
        line: 5,
        lineType: 'ADDED',
        srcPath: 'src/old.ts',
      },
    });
  });

  it('omits srcPath when there is no rename', () => {
    const payload = toServerInlineCommentPayload({
      text: 'n',
      path: 'a',
      line: 1,
      lineKind: 'context',
    });
    expect(payload.anchor.srcPath).toBe(undefined);
    expect(payload.anchor.lineType).toBe('CONTEXT');
  });

  it('encodes a multiline suggestion via multilineMarker/multilineSpan', () => {
    const payload = toServerInlineCommentPayload({
      text: 'replace me',
      path: 'x',
      line: 12,
      lineKind: 'added',
      suggestion: { replacement: 'foo', startLine: 10, endLine: 12 },
    });
    expect(payload.anchor.multilineMarker).toEqual({ startLine: 10, startLineType: 'ADDED' });
    expect(payload.anchor.multilineSpan).toEqual({ dstSpanStart: 10, dstSpanEnd: 12 });
  });

  it('omits multiline fields when suggestion is single-line (startLine === endLine)', () => {
    const payload = toServerInlineCommentPayload({
      text: 't',
      path: 'x',
      line: 5,
      lineKind: 'added',
      suggestion: { replacement: 'r', startLine: 5, endLine: 5 },
    });
    expect(payload.anchor.multilineMarker).toBe(undefined);
    expect(payload.anchor.multilineSpan).toBe(undefined);
  });
});
