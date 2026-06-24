import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { LlmClient } from '../reviewer/llm-client';
import type { MentionTool } from '../types';
import { MentionRouteSchema, mentionRouteJsonSchema, parseWithSchema } from '../reviewer/llm-schemas';

export interface IRouteResult {
  tool: MentionTool;
  message: string;
  reasoning: string;
}

const TOOL_DESCRIPTIONS = [
  'fix — apply a code change based on the user instruction',
  'autofix — fix all review findings (collects bot review comments, runs lint)',
  'revert — create a revert PR for a commit the user specifies',
  'review — re-run full PR code review',
  'explain — answer a question about the code or a bot finding',
  'reply — acknowledge, clarify, or respond conversationally',
  'ignore — no action needed (noise, thanks, accidental tag)',
].join('\n');

const SYSTEM_PROMPT = [
  'You are a PR bot routing user mentions to the right tool.',
  "Pick the best tool for the user's intent. Reformulate their message into a clear instruction.",
  `Available tools:\n${TOOL_DESCRIPTIONS}`,
  'Return JSON: { "tool": "...", "message": "refined instruction", "reasoning": "one sentence why" }',
].join('\n');

const DEFAULT_FALLBACK: IRouteResult = {
  tool: 'reply',
  message: "I'm not sure what you're asking. Can you rephrase?",
  reasoning: 'all routing LLMs failed',
};

export class MentionRouter {
  constructor(private readonly llmChain: LlmClient[]) {}

  public get firstAvailableLlm(): LlmClient | undefined {
    return this.llmChain[0];
  }

  public async route(contextPayload: string): Promise<IRouteResult> {
    for (const llm of this.llmChain) {
      const result = await this.tryRoute(llm, contextPayload);
      if (result) return result;
    }
    return DEFAULT_FALLBACK;
  }

  /** Generate a conversational response for explain/reply tools */
  public async generateResponse(llm: LlmClient, mentionText: string, contextPayload: string): Promise<string> {
    try {
      const response = await llm.chat(
        'You are a helpful PR bot. Answer the user based on the context. Be concise.',
        `${contextPayload}\n\n## User message\n${mentionText}`,
      );
      return response.content.slice(0, 2000);
    } catch (err) {
      LogSink.warn(`Response generation failed: ${err}`, TraceTags.PI);
      return "Sorry, I couldn't generate a response. Please try again.";
    }
  }

  private async tryRoute(llm: LlmClient, contextPayload: string): Promise<IRouteResult | null> {
    try {
      const response = await llm.chat(SYSTEM_PROMPT, contextPayload, {
        jsonMode: true,
        jsonSchema: mentionRouteJsonSchema,
      });
      const parsed = parseWithSchema(response.content, MentionRouteSchema);
      if (!parsed) {
        LogSink.warn(`Router: ${llm.name} returned unparseable response`, TraceTags.PI);
        return null;
      }
      LogSink.debug(`Router: ${llm.name} → ${parsed.tool} (${parsed.reasoning})`, TraceTags.PI);
      return parsed;
    } catch (err) {
      LogSink.warn(`Router: ${llm.name} failed: ${err}`, TraceTags.PI);
      return null;
    }
  }
}
