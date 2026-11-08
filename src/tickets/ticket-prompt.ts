import type { IJiraRawComment } from '../jira/jira-identity';

/** Most recent ticket comments carried into the implementation prompt. */
export const MAX_PROMPT_COMMENTS = 10;

export interface ITicketPromptInput {
  key: string;
  summary: string;
  /** Full description. The 800-char cap of the review context does not apply here. */
  description: string;
  /** Ascending by id; only the last MAX_PROMPT_COMMENTS are rendered. */
  comments: IJiraRawComment[];
  /** Continue mode: the mention comment that asked for more work. */
  instruction?: { author: string; text: string };
  /** Repo rules files (CLAUDE.md, AGENTS.md, ...) read from the default branch. */
  rules: Array<{ fileName: string; content: string }>;
}

/** The request text the council validates the diff against. */
export function ticketRequestText(input: Pick<ITicketPromptInput, 'key' | 'summary' | 'description'>): string {
  return `${input.key}: ${input.summary}\n\n${input.description}`.trimEnd();
}

/** Build `ticket.md` for the pi implementation run. */
export function buildTicketMarkdown(input: ITicketPromptInput): string {
  const blocks: string[] = [
    `# ${input.key}: ${input.summary}`,
    '## Description',
    input.description.trim() || '(no description)',
  ];

  const recent = input.comments.slice(-MAX_PROMPT_COMMENTS);
  if (recent.length > 0) {
    const lines = recent.map((c) => {
      const date = c.created ? c.created.slice(0, 10) : 'unknown date';
      return `- ${c.author.displayName || 'unknown'} (${date}): ${c.text.replace(/\s+/g, ' ').trim()}`;
    });
    blocks.push('## Comments (oldest first)', lines.join('\n'));
  }

  if (input.instruction) {
    blocks.push(`## Instruction from ${input.instruction.author}`, input.instruction.text.trim());
  }

  for (const rule of input.rules) {
    if (!rule.content.trim()) continue;
    blocks.push(`## Rules: ${rule.fileName}`, rule.content.trim());
  }

  return `${blocks.join('\n\n')}\n`;
}
