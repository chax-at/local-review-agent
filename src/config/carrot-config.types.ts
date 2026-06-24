export interface ICarrotConfig {
  /** Enable PR code review by the bot */
  prReview: boolean;
  /** Docker image for the pi coding agent. Default: node:lts-slim */
  dockerImage?: string;
  /** Files to read for code standards/rules (from target branch). Default: ['CLAUDE.md', 'AGENTS.md'] */
  rulesFiles?: string[];
  /** Include LLM-generated fix prompts in review summaries and rejection comments. Default: false */
  generateFixPrompts?: boolean;
  /** Post applicable code suggestions on inline review comments (validator-approved). Default: true */
  suggestCodeFixes?: boolean;
}

export const CARROT_CONFIG_DEFAULTS: Partial<ICarrotConfig> = {
  prReview: false,
  rulesFiles: ['CLAUDE.md', 'AGENTS.md'],
};
