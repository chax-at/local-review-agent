export interface IMentionContext {
  mentionText: string;
  parentComment?: string;
  siblingReplies: string[];
  anchorFile?: string;
  anchorLine?: number;
  anchorCode?: string;
  botCommentOnAnchor?: string;
  botCommentsOnPr: Array<{ path?: string; line?: number; text: string }>;
}

/** Slice file content to ~windowSize lines centered on targetLine */
export function sliceCodeAroundLine(fileContent: string, targetLine: number, windowSize = 150): string {
  const lines = fileContent.split('\n');
  const half = Math.floor(windowSize / 2);
  const start = Math.max(0, targetLine - 1 - half);
  const end = Math.min(lines.length, start + windowSize);
  return lines.slice(start, end).join('\n');
}

/** Format context payload as a string for the router LLM */
export function buildMentionContext(ctx: IMentionContext): string {
  const sections: string[] = [];

  sections.push(`## Mention\n${ctx.mentionText}`);

  if (ctx.parentComment) {
    sections.push(`## Parent comment\n${ctx.parentComment}`);
  }
  if (ctx.siblingReplies.length > 0) {
    sections.push(`## Thread\n${ctx.siblingReplies.join('\n---\n')}`);
  }

  if (ctx.anchorFile && ctx.anchorLine) {
    sections.push(`## Anchor\n${ctx.anchorFile}:${ctx.anchorLine}`);
  }
  if (ctx.anchorCode) {
    sections.push(`## Code\n\`\`\`\n${ctx.anchorCode}\n\`\`\``);
  }
  if (ctx.botCommentOnAnchor) {
    sections.push(`## Bot finding on this line\n${ctx.botCommentOnAnchor}`);
  }

  if (ctx.botCommentsOnPr.length > 0) {
    const formatted = ctx.botCommentsOnPr
      .slice(0, 20)
      .map((c) => `${c.path ?? 'general'}${c.line ? `:${c.line}` : ''}: ${c.text.slice(0, 200)}`)
      .join('\n');
    sections.push(`## Bot findings on this PR\n${formatted}`);
  }

  return sections.join('\n\n');
}
