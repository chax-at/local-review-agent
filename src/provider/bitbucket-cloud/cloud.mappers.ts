// src/provider/bitbucket-cloud/cloud.mappers.ts
import type { IPullRequest, IComment, IBuildStatus, IRepo } from '../provider.types';
import type { ICloudPullRequest, ICloudComment, ICloudBuildStatus, ICloudRepository, ICloudUser } from './cloud.types';

export function cloudUserId(user: ICloudUser | undefined): string {
  return user?.account_id ?? user?.nickname ?? user?.display_name ?? '';
}

export function toPullRequestCloud(wire: ICloudPullRequest): IPullRequest {
  const createdAt = Date.parse(wire.created_on);
  const updatedAt = Date.parse(wire.updated_on);
  return {
    id: wire.id,
    title: wire.title,
    draft: wire.draft ?? false,
    isOpen: wire.state === 'OPEN',
    createdAt: Number.isNaN(createdAt) ? null : createdAt,
    updatedAt: Number.isNaN(updatedAt) ? null : updatedAt,
    sourceBranch: wire.source.branch.name,
    sourceCommit: wire.source.commit.hash,
    targetBranch: wire.destination.branch.name,
    authorUsername: cloudUserId(wire.author),
  };
}

/**
 * Cloud comments are returned flat from /comments; replies link to their parent via parent.id.
 * Caller passes the full sibling array so we can attach this comment's direct children.
 */
export function toCommentCloud(wire: ICloudComment, allComments: ICloudComment[]): IComment {
  const anchor = wire.inline
    ? {
        path: wire.inline.path,
        line: wire.inline.to ?? wire.inline.from ?? 0,
      }
    : undefined;

  const replies = allComments
    .filter((c) => c.parent?.id === wire.id)
    .map((c) => ({
      id: c.id,
      text: c.content.raw,
      authorUsername: cloudUserId(c.user),
    }));

  return {
    id: wire.id,
    text: wire.content.raw,
    authorUsername: cloudUserId(wire.user),
    anchor,
    replies,
  };
}

const CLOUD_BUILD_STATE_MAP: Record<ICloudBuildStatus['state'], IBuildStatus['state']> = {
  SUCCESSFUL: 'successful',
  FAILED: 'failed',
  INPROGRESS: 'in_progress',
  STOPPED: 'failed',
};

export function toBuildStatusCloud(wire: ICloudBuildStatus): IBuildStatus {
  return {
    state: CLOUD_BUILD_STATE_MAP[wire.state],
    url: wire.url,
    key: wire.key,
  };
}

export function toRepoCloud(wire: ICloudRepository, workspace: string): IRepo {
  return { slug: wire.slug, projectKey: workspace };
}
