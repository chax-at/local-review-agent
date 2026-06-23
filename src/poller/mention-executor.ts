import type { IRouteResult } from './mention-router';
import type { ReviewerService } from '../reviewer/reviewer.service';

/**
 * Outcome of a mention-routed action. `success: false` means the action ran
 * but its outcome is negative (e.g. a fix that the council rejected); the
 * poller renders an ❌ prefix instead of ✅.
 */
export interface IMentionToolResult {
  success: boolean;
  message: string;
}

interface IExecutorDeps {
  reviewer: ReviewerService;
  handleRevert: (message: string) => Promise<string>;
  handleAuditFix: () => Promise<string>;
  postReply: (text: string) => Promise<void>;
  pr: {
    project: string;
    slug: string;
    prId: number;
    sourceBranch: string;
    sourceCommit: string;
    targetBranch: string;
    dockerImage?: string;
    rulesFiles?: string[];
    generateFixPrompts?: boolean;
  };
}

export async function executeMentionTool(
  route: IRouteResult,
  mention: { prId: number; repoKey: string; commentId?: number },
  deps: IExecutorDeps,
): Promise<IMentionToolResult | null> {
  const { pr } = deps;

  switch (route.tool) {
    case 'fix':
      return deps.reviewer.fixPr(
        pr.project,
        pr.slug,
        pr.prId,
        pr.sourceBranch,
        pr.targetBranch,
        route.message,
        pr.dockerImage,
        pr.generateFixPrompts,
      );
    case 'autofix':
      return deps.reviewer.autofixPr(
        pr.project,
        pr.slug,
        pr.prId,
        pr.sourceBranch,
        pr.targetBranch,
        pr.dockerImage,
        pr.generateFixPrompts,
      );
    case 'revert':
      return { success: true, message: await deps.handleRevert(route.message) };
    case 'review':
      // Explicit re-review: pass the commit so the summary still carries the
      // marker, but leave skipIfReviewed false — the user asked for it.
      await deps.reviewer.reviewPr(
        pr.project,
        pr.slug,
        pr.prId,
        pr.targetBranch,
        pr.sourceBranch,
        pr.dockerImage,
        pr.rulesFiles,
        pr.generateFixPrompts,
        pr.sourceCommit,
      );
      return { success: true, message: 'Review posted.' };
    case 'audit_fix':
      return { success: true, message: await deps.handleAuditFix() };
    case 'explain':
    case 'reply':
      await deps.postReply(route.message);
      return null;
    case 'ignore':
      return null;
  }
}
