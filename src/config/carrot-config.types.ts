export interface IAuditSchedule {
  /** Branch to audit (e.g. "master", "release") */
  branch: string;
  /** Only trigger if last audit check is older than this many days */
  staleAfterDays: number;
  /** Hour of day to run (0-23, server-local timezone) */
  hour: number;
  /** Minute of hour to run (0-59) */
  minute: number;
}

export interface ICarrotConfig {
  /** Directories containing package.json to audit */
  packages: string[];
  /** Enable PR code review by the bot */
  prReview: boolean;
  /** Enable Bamboo audit fix */
  bambooFix: boolean;
  /** How to deliver audit fixes: "direct", "pr", or "protected-only" */
  fixDelivery: 'direct' | 'pr' | 'protected-only';
  /** Branches considered protected (glob patterns) */
  protectedBranches: string[];
  /** Docker image for the pi coding agent. Default: node:lts-slim */
  dockerImage?: string;
  /**
   * Bamboo plan keys (e.g. `PROJ-PLAN`) to poll for this repo. Optional; if at least one
   * bamboo-enabled repo lists keys, only those plans are scanned; otherwise all plans are scanned.
   */
  bambooPlanKeys?: string[];
  /** Scheduled audit checks — run audits on branches even without a failed build */
  auditSchedules?: IAuditSchedule[];
  /** Files to read for code standards/rules (from target branch). Default: ['CLAUDE.md', 'AGENTS.md'] */
  rulesFiles?: string[];
  /** Include LLM-generated fix prompts in review summaries and rejection comments. Default: false */
  generateFixPrompts?: boolean;
  /** Post applicable code suggestions on inline review comments (validator-approved). Default: true */
  suggestCodeFixes?: boolean;
}

export const CARROT_CONFIG_DEFAULTS: Partial<ICarrotConfig> = {
  packages: ['.'],
  prReview: false,
  bambooFix: false,
  fixDelivery: 'protected-only',
  protectedBranches: ['main', 'master', 'release/*'],
  rulesFiles: ['CLAUDE.md', 'AGENTS.md'],
};
