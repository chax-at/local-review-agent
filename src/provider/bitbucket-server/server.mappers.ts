import type {
  IPullRequest,
  IComment,
  IActivity,
  IBuildStatus,
  IProject,
  IRepo,
  IInlineCommentInput,
} from '../provider.types';
import type {
  IBitbucketPullRequest,
  IBitbucketComment,
  IBitbucketActivity,
  IBitbucketBuildStatus,
  IBitbucketProject,
  IBitbucketRepo,
  IBitbucketInlineCommentPayload,
} from './server.types';

export function toPullRequest(wire: IBitbucketPullRequest): IPullRequest {
  return {
    id: wire.id,
    title: wire.title,
    draft: wire.draft ?? false,
    isOpen: wire.state === 'OPEN',
    createdAt: wire.createdDate ?? null,
    updatedAt: wire.updatedDate ?? null,
    sourceBranch: wire.fromRef.displayId,
    sourceCommit: wire.fromRef.latestCommit,
    targetBranch: wire.toRef.displayId,
    authorUsername: wire.author.user.slug,
  };
}

export function toComment(wire: IBitbucketComment): IComment;
export function toComment(wire: IBitbucketActivity['comment']): IComment;
export function toComment(wire: any): IComment {
  return {
    id: wire.id,
    text: wire.text,
    authorUsername: wire.author.slug,
    anchor: wire.anchor ? { path: wire.anchor.path, line: wire.anchor.line } : undefined,
    replies: (wire.comments ?? []).map((c: { id: number; text: string; author: { slug: string } }) => ({
      id: c.id,
      text: c.text,
      authorUsername: c.author.slug,
    })),
  };
}

export function toActivity(wire: IBitbucketActivity): IActivity {
  return {
    id: wire.id,
    comment: wire.comment ? toComment(wire.comment) : undefined,
  };
}

const BUILD_STATE_MAP = {
  SUCCESSFUL: 'successful',
  FAILED: 'failed',
  INPROGRESS: 'in_progress',
} as const;

export function toBuildStatus(wire: IBitbucketBuildStatus): IBuildStatus {
  return {
    state: BUILD_STATE_MAP[wire.state],
    url: wire.url,
    key: wire.key,
  };
}

export function toProject(wire: IBitbucketProject): IProject {
  return { key: wire.key, name: wire.name };
}

export function toRepo(wire: IBitbucketRepo): IRepo {
  return { slug: wire.slug, projectKey: wire.project.key };
}

export function toServerInlineCommentPayload(input: IInlineCommentInput): IBitbucketInlineCommentPayload {
  const lineType = input.lineKind.toUpperCase() as 'ADDED' | 'REMOVED' | 'CONTEXT';
  const anchor: IBitbucketInlineCommentPayload['anchor'] = {
    path: input.path,
    line: input.line,
    lineType,
  };
  if (input.oldPath) anchor.srcPath = input.oldPath;

  if (input.suggestion && input.suggestion.startLine !== input.suggestion.endLine) {
    anchor.multilineMarker = {
      startLine: input.suggestion.startLine,
      startLineType: 'ADDED',
    };
    anchor.multilineSpan = {
      dstSpanStart: input.suggestion.startLine,
      dstSpanEnd: input.suggestion.endLine,
    };
  }

  return { text: input.text, anchor };
}
