import { describe, it, expect, vi, beforeEach } from 'vitest';

// The fix loop (src/reviewer/fix-loop.ts) shells out to `git` via `execSync`
// directly, bypassing the injected `git` double — mock it at the module level
// so the council-rejection test can drive it deterministically.
vi.mock('child_process', () => ({ execSync: vi.fn() }));

import { execSync } from 'child_process';
import {
  TicketService,
  NOT_ASSIGNED_REPLY,
  buildResultComment,
  type ITicketServiceDeps,
} from '../../src/tickets/ticket.service';

const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;

const bot = { accountId: 'bot', displayName: 'Carrot' };
const human = { accountId: 'h', displayName: 'H' };
const comment = (id: number, text: string, author = human) => ({ id, author, created: '', text, body: text });

export function buildDeps(overrides: Partial<ITicketServiceDeps> = {}): ITicketServiceDeps & {
  jira: ITicketServiceDeps['jira'] & Record<string, ReturnType<typeof vi.fn>>;
  state: ITicketServiceDeps['state'] & { tickets: Record<string, unknown> };
} {
  const tickets: Record<string, unknown> = {};
  const state = {
    tickets,
    getTicketState: vi.fn((k: string) => tickets[k]),
    setTicketState: vi.fn((k: string, v: unknown) => {
      tickets[k] = v;
    }),
    save: vi.fn(),
  };
  const jira = {
    isEnabled: true,
    getMyself: vi.fn().mockResolvedValue(bot),
    searchIssues: vi.fn().mockResolvedValue([]),
    getIssueForRun: vi.fn(),
    addComment: vi.fn().mockResolvedValue(true),
    assign: vi.fn().mockResolvedValue(true),
    getTransitions: vi.fn().mockResolvedValue([]),
    transition: vi.fn().mockResolvedValue(true),
    issueUrl: (k: string) => `https://j/browse/${k}`,
  };
  const provider = {
    listProjects: vi.fn().mockResolvedValue([{ key: 'P' }]),
    listRepos: vi.fn().mockResolvedValue([{ projectKey: 'P', slug: 'api' }]),
    listBranches: vi.fn().mockResolvedValue(['main']),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    getOpenPullRequests: vi.fn().mockResolvedValue([]),
    createFixPr: vi.fn().mockResolvedValue(42),
    postGeneralComment: vi.fn().mockResolvedValue(1),
    getFileContent: vi.fn().mockResolvedValue(null),
  };
  const carrotConfig = {
    getConfig: vi.fn().mockResolvedValue({ prReview: true, jiraProjects: ['ABC'] }),
  };
  const pi = {
    implement: vi.fn().mockReturnValue({ summary: 'did it', usage: { inputTokens: 1, outputTokens: 1 } }),
    fix: vi.fn(),
    runLint: vi.fn().mockReturnValue({ failed: false, output: '' }),
  };
  const git = {
    cloneOrFetch: vi.fn(),
    resetToRemoteBranch: vi.fn(),
    getRepoDir: vi.fn().mockReturnValue('/repos/P/api'),
    createBranchCommitAndPush: vi.fn(),
    commitAndPush: vi.fn().mockReturnValue('abc123'),
    execGit: vi.fn().mockReturnValue(''),
    redactPat: vi.fn((s: string) => s),
  };
  return {
    provider: provider as never,
    git: git as never,
    jira: jira as never,
    state: state as never,
    carrotConfig: carrotConfig as never,
    implementModel: { name: 'Impl', pi: pi as never, roles: ['generic'], inputCostPer1M: 0, outputCostPer1M: 0 },
    multiValidator: { hasModels: false, withRandomSubset: vi.fn().mockReturnThis() } as never,
    maxValidators: 0,
    repoPicker: { pick: vi.fn(async (_t: unknown, c: unknown[]) => ({ repo: c[0] ?? null, usage: [] })) } as never,
    failureExplainer: { isEnabled: false, explain: vi.fn() } as never,
    heartbeat: () => {},
    ...overrides,
  } as never;
}

describe('TicketService.init', () => {
  it('returns false and skips polling when Jira is disabled', async () => {
    const deps = buildDeps();
    (deps.jira as { isEnabled: boolean }).isEnabled = false;
    const svc = new TicketService(deps);
    expect(await svc.init()).toBe(false);
    await svc.pollTickets();
    expect(deps.jira.searchIssues).not.toHaveBeenCalled();
  });

  it('returns false when no implement model is configured', async () => {
    const svc = new TicketService(buildDeps({ implementModel: null }));
    expect(await svc.init()).toBe(false);
  });
});

describe('TicketService mentions on tickets not assigned to carrot', () => {
  let deps: ReturnType<typeof buildDeps>;
  beforeEach(() => {
    deps = buildDeps();
  });

  it('replies once and does no work', async () => {
    deps.jira.searchIssues.mockResolvedValueOnce([]).mockResolvedValueOnce(['ABC-9']);
    deps.jira.getIssueForRun.mockResolvedValue({
      key: 'ABC-9',
      summary: 's',
      description: '',
      reporter: human,
      assignee: human,
      comments: [comment(3, '@carrot please do this')],
      assignment: null,
    });
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();

    expect(deps.jira.addComment).toHaveBeenCalledWith('ABC-9', NOT_ASSIGNED_REPLY);
    expect(
      (deps.implementModel!.pi as never as { implement: ReturnType<typeof vi.fn> }).implement,
    ).not.toHaveBeenCalled();
    expect(deps.state.tickets['ABC-9']).toMatchObject({ lastCommentId: 3 });

    // Second cycle: same comments, watermark set → no second reply.
    deps.jira.searchIssues.mockResolvedValueOnce([]).mockResolvedValueOnce(['ABC-9']);
    await svc.pollTickets();
    expect(deps.jira.addComment).toHaveBeenCalledTimes(1);
  });

  it('does not reply when the only "mention" is the bot own comment', async () => {
    deps.jira.searchIssues.mockResolvedValueOnce([]).mockResolvedValueOnce(['ABC-9']);
    deps.jira.getIssueForRun.mockResolvedValue({
      key: 'ABC-9',
      summary: 's',
      description: '',
      reporter: human,
      assignee: human,
      comments: [comment(3, 'Mention @carrot to continue', bot)],
      assignment: null,
    });
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect(deps.jira.addComment).not.toHaveBeenCalled();
  });
});

describe('TicketService assigned tickets without a repo', () => {
  it('skips a ticket whose project key no repo claims, and stays silent', async () => {
    const deps = buildDeps();
    deps.jira.searchIssues.mockResolvedValueOnce(['ZZZ-1']).mockResolvedValueOnce([]);
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect(deps.jira.getIssueForRun).not.toHaveBeenCalled();
    expect(deps.jira.addComment).not.toHaveBeenCalled();
  });

  it('does not build the repo map when both queries are empty', async () => {
    const deps = buildDeps();
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect((deps.provider as never as { listRepos: ReturnType<typeof vi.fn> }).listRepos).not.toHaveBeenCalled();
  });

  it('skips a mention on a ticket whose project key no repo claims, and stays silent', async () => {
    const deps = buildDeps();
    deps.jira.searchIssues.mockResolvedValueOnce([]).mockResolvedValueOnce(['ZZZ-9']);
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect(deps.jira.getIssueForRun).not.toHaveBeenCalled();
    expect(deps.jira.addComment).not.toHaveBeenCalled();
  });
});

describe('TicketService error isolation', () => {
  it('continues with the next assigned ticket when one handler throws', async () => {
    const deps = buildDeps();
    deps.jira.searchIssues.mockResolvedValueOnce(['ABC-1', 'ABC-2']).mockResolvedValueOnce([]);
    deps.jira.getIssueForRun.mockImplementation((key: string) => {
      if (key === 'ABC-1') return Promise.reject(new Error('boom'));
      return Promise.resolve({
        key,
        summary: 's',
        description: '',
        reporter: human,
        assignee: human,
        comments: [],
        assignment: null,
      });
    });
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect(deps.jira.getIssueForRun).toHaveBeenCalledWith('ABC-2', bot);
  });

  it('treats a repo whose carrot config fetch throws as having no config, and still handles other repos', async () => {
    const deps = buildDeps();
    (deps.provider as never as { listRepos: ReturnType<typeof vi.fn> }).listRepos.mockResolvedValue([
      { projectKey: 'P', slug: 'api' },
      { projectKey: 'P', slug: 'web' },
    ]);
    (deps.carrotConfig as never as { getConfig: ReturnType<typeof vi.fn> }).getConfig.mockImplementation(
      (_project: string, slug: string) => {
        if (slug === 'api') return Promise.reject(new Error('fetch failed'));
        return Promise.resolve({ prReview: true, jiraProjects: ['ABC'] });
      },
    );
    deps.jira.searchIssues.mockResolvedValueOnce(['ABC-9']).mockResolvedValueOnce([]);
    deps.jira.getIssueForRun.mockResolvedValue({
      key: 'ABC-9',
      summary: 's',
      description: '',
      reporter: human,
      assignee: human,
      comments: [],
      assignment: null,
    });
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect(deps.jira.getIssueForRun).toHaveBeenCalledWith('ABC-9', bot);
  });
});

describe('buildResultComment', () => {
  it('lists branch, PR, summary and footer in order', () => {
    const text = buildResultComment({
      branch: 'feature/ABC-1-x',
      prUrlOrId: 'PR #42',
      summary: 'Added retry.',
      footer: '---\n*cost*',
    });
    expect(text.indexOf('feature/ABC-1-x')).toBeLessThan(text.indexOf('PR #42'));
    expect(text.indexOf('PR #42')).toBeLessThan(text.indexOf('Added retry.'));
    expect(text.endsWith('*cost*')).toBe(true);
  });
});

describe('TicketService.runTicket', () => {
  const issueBase = {
    key: 'ABC-1',
    summary: 'Add retry to upload',
    description: 'Please add retries.',
    reporter: { accountId: 'rep', displayName: 'Rep' },
    assignee: bot,
    comments: [comment(2, 'context')],
    assignment: { assignedAt: '2026-09-10T10:00:00.000+0000', assignedBy: { accountId: 'lead', displayName: 'Lead' } },
  };

  let deps: ReturnType<typeof buildDeps>;
  beforeEach(() => {
    deps = buildDeps();
    deps.jira.searchIssues.mockResolvedValueOnce(['ABC-1']).mockResolvedValueOnce([]);
    execSyncMock.mockReset().mockReturnValue('');
  });

  const pi = () => deps.implementModel!.pi as never as Record<string, ReturnType<typeof vi.fn>>;
  const git = () => deps.git as never as Record<string, ReturnType<typeof vi.fn>>;
  const provider = () => deps.provider as never as Record<string, ReturnType<typeof vi.fn>>;

  it('fresh mode: implements, pushes feature/KEY-slug from the default branch, opens a PR, comments, reassigns to the assigner', async () => {
    deps.jira.getIssueForRun.mockResolvedValue(issueBase);
    git().execGit.mockImplementation((args: string[]) => (args[0] === 'status' ? ' M a.ts' : ''));
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();

    expect(git().resetToRemoteBranch).toHaveBeenCalledWith('P', 'api', 'main');
    expect(pi().implement).toHaveBeenCalledTimes(1);
    expect(pi().implement.mock.calls[0][1]).toContain('# ABC-1: Add retry to upload');
    expect(git().createBranchCommitAndPush).toHaveBeenCalledWith(
      'P',
      'api',
      'feature/ABC-1-add-retry-to-upload',
      'feat(ABC-1): Add retry to upload',
    );
    const branchDeleteCallIndex = git().execGit.mock.calls.findIndex(
      (c: unknown[]) => Array.isArray(c[0]) && c[0][0] === 'branch' && c[0][1] === '-D',
    );
    expect(branchDeleteCallIndex).toBeGreaterThanOrEqual(0);
    expect(git().execGit.mock.calls[branchDeleteCallIndex][0]).toEqual([
      'branch',
      '-D',
      'feature/ABC-1-add-retry-to-upload',
    ]);
    expect(git().execGit.mock.invocationCallOrder[branchDeleteCallIndex]).toBeLessThan(
      git().createBranchCommitAndPush.mock.invocationCallOrder[0],
    );
    expect(provider().createFixPr).toHaveBeenCalledWith(
      'P',
      'api',
      'ABC-1: Add retry to upload',
      expect.stringContaining('https://j/browse/ABC-1'),
      'feature/ABC-1-add-retry-to-upload',
      'main',
    );
    expect(deps.jira.addComment).toHaveBeenCalledWith(
      'ABC-1',
      expect.stringContaining('feature/ABC-1-add-retry-to-upload'),
    );
    expect(deps.jira.assign).toHaveBeenCalledWith('ABC-1', { accountId: 'lead', displayName: 'Lead' });
    expect(deps.state.tickets['ABC-1']).toMatchObject({
      repoKey: 'P/api',
      branch: 'feature/ABC-1-add-retry-to-upload',
      prId: 42,
      attempts: 0,
      lastCommentId: 2,
    });
  });

  it('fresh mode with an existing branch: no run, comments, hands back', async () => {
    deps.jira.getIssueForRun.mockResolvedValue(issueBase);
    provider().listBranches.mockResolvedValue(['main', 'feature/ABC-1-old-name']);
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();

    expect(pi().implement).not.toHaveBeenCalled();
    expect(deps.jira.addComment).toHaveBeenCalledWith(
      'ABC-1',
      expect.stringContaining('feature/ABC-1-old-name already exists'),
    );
    expect(deps.jira.assign).toHaveBeenCalledWith('ABC-1', { accountId: 'lead', displayName: 'Lead' });
    expect(deps.state.tickets['ABC-1']).toMatchObject({ branch: 'feature/ABC-1-old-name', attempts: 0 });
  });

  it('continue mode on an existing branch: resets to it, commits on it, comments on the open PR instead of creating one', async () => {
    deps.state.tickets['ABC-1'] = {
      repoKey: 'P/api',
      branch: 'feature/ABC-1-old-name',
      prId: 7,
      attempts: 0,
      lastCommentId: 2,
      lastRunAt: '2026-09-11T00:00:00.000Z',
    };
    deps.jira.getIssueForRun.mockResolvedValue({
      ...issueBase,
      comments: [comment(2, 'context'), comment(5, '@carrot also add tests')],
    });
    provider().listBranches.mockResolvedValue(['main', 'feature/ABC-1-old-name']);
    provider().getOpenPullRequests.mockResolvedValue([{ id: 7, sourceBranch: 'feature/ABC-1-old-name' }]);
    git().execGit.mockImplementation((args: string[]) => (args[0] === 'status' ? ' M a.ts' : ''));
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();

    expect(git().resetToRemoteBranch).toHaveBeenCalledWith('P', 'api', 'feature/ABC-1-old-name');
    expect(pi().implement.mock.calls[0][1]).toContain('## Instruction from H');
    expect(git().commitAndPush).toHaveBeenCalled();
    expect(git().createBranchCommitAndPush).not.toHaveBeenCalled();
    expect(provider().createFixPr).not.toHaveBeenCalled();
    expect(provider().postGeneralComment).toHaveBeenCalledWith('P', 'api', 7, expect.any(String));
    expect(deps.state.tickets['ABC-1']).toMatchObject({ lastCommentId: 5, prId: 7 });
  });

  it('safe stop: discards changes and pushes nothing when the ticket was unassigned during the run', async () => {
    deps.jira.getIssueForRun.mockResolvedValueOnce(issueBase).mockResolvedValueOnce({ ...issueBase, assignee: human });
    git().execGit.mockImplementation((args: string[]) => (args[0] === 'status' ? ' M a.ts' : ''));
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();

    expect(git().createBranchCommitAndPush).not.toHaveBeenCalled();
    expect(deps.jira.addComment).toHaveBeenCalledWith(
      'ABC-1',
      expect.stringContaining('unassigned from me during the run'),
    );
    expect(deps.jira.assign).not.toHaveBeenCalled();
    expect(git().execGit.mock.calls.map((c) => c[0][0])).toContain('clean');
  });

  it('safe stop fails closed: does not push when the re-check itself fails', async () => {
    deps.jira.getIssueForRun.mockResolvedValueOnce(issueBase).mockResolvedValueOnce(null);
    git().execGit.mockImplementation((args: string[]) => (args[0] === 'status' ? ' M a.ts' : ''));
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();

    expect(git().createBranchCommitAndPush).not.toHaveBeenCalled();
    expect(git().commitAndPush).not.toHaveBeenCalled();
    expect(provider().createFixPr).not.toHaveBeenCalled();
    expect(deps.state.tickets['ABC-1']).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining('re-check'),
    });
  });

  it('failure: counts attempts, stays assigned, and hands back with the error on the 3rd failure', async () => {
    deps.jira.getIssueForRun.mockResolvedValue(issueBase);
    pi().implement.mockImplementation(() => {
      throw new Error('docker exploded');
    });
    const svc = new TicketService(deps);
    await svc.init();

    await svc.pollTickets();
    expect(deps.state.tickets['ABC-1']).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining('docker exploded'),
    });
    expect(deps.jira.assign).not.toHaveBeenCalled();

    // Same issue, no re-assignment needed: a failed run is retried next cycle
    // while the ticket stays assigned (decideTicketMode fresh-mode-on-attempts>0).
    deps.jira.searchIssues.mockResolvedValueOnce(['ABC-1']).mockResolvedValueOnce([]);
    await svc.pollTickets();
    expect(deps.state.tickets['ABC-1']).toMatchObject({ attempts: 2 });

    deps.jira.searchIssues.mockResolvedValueOnce(['ABC-1']).mockResolvedValueOnce([]);
    await svc.pollTickets();
    expect(deps.state.tickets['ABC-1']).toMatchObject({ attempts: 0 });
    expect(deps.jira.addComment).toHaveBeenCalledWith('ABC-1', expect.stringContaining('docker exploded'));
    expect(deps.jira.assign).toHaveBeenCalledWith('ABC-1', { accountId: 'lead', displayName: 'Lead' });
  });

  it('failure before the try: a rejected listBranches still counts an attempt', async () => {
    deps.jira.getIssueForRun.mockResolvedValue(issueBase);
    provider().listBranches.mockRejectedValue(new Error('bitbucket down'));
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect(pi().implement).not.toHaveBeenCalled();
    expect(deps.state.tickets['ABC-1']).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining('bitbucket down'),
    });
  });

  it('PR step fails after a successful push: keeps the branch on record and counts an attempt', async () => {
    deps.jira.getIssueForRun.mockResolvedValue(issueBase);
    git().execGit.mockImplementation((args: string[]) => (args[0] === 'status' ? ' M a.ts' : ''));
    provider().getOpenPullRequests.mockResolvedValue([]);
    provider().createFixPr.mockRejectedValue(new Error('pr failed'));
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect(git().createBranchCommitAndPush).toHaveBeenCalled();
    expect(deps.state.tickets['ABC-1']).toMatchObject({
      branch: 'feature/ABC-1-add-retry-to-upload',
      attempts: 1,
      lastError: expect.stringContaining('pr failed'),
    });
    expect(deps.jira.assign).not.toHaveBeenCalled();
  });

  it('no changes after pi → failed run', async () => {
    deps.jira.getIssueForRun.mockResolvedValue(issueBase);
    git().execGit.mockImplementation((args: string[]) => (args[0] === 'status' ? '' : ''));
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    // With hasModels=false the loop is skipped; a clean tree after pi means nothing to deliver.
    expect(deps.state.tickets['ABC-1']).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining('No changes were needed'),
    });
  });

  it('council rejection: validators reject the fix, nothing is pushed', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('status')) return ' M a.ts';
      if (cmd.includes('diff')) return 'diff';
      return '';
    });
    git().execGit.mockImplementation((args: string[]) => (args[0] === 'status' ? ' M a.ts' : ''));
    const rejectingValidator = {
      hasModels: true,
      modelNames: ['V'],
      validateFix: vi.fn().mockResolvedValue({ approved: false, summary: 'wrong', usage: [] }),
      summarizeFailure: vi.fn().mockResolvedValue({ summary: 'not good', usage: [] }),
      generateRejectionPrompt: vi.fn().mockResolvedValue({ prompt: '', usage: [] }),
    };
    (deps.multiValidator as never as { withRandomSubset: ReturnType<typeof vi.fn> }).withRandomSubset.mockReturnValue(
      rejectingValidator,
    );
    deps.jira.getIssueForRun.mockResolvedValue(issueBase);
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();

    expect(git().createBranchCommitAndPush).not.toHaveBeenCalled();
    expect(git().commitAndPush).not.toHaveBeenCalled();
    expect(provider().createFixPr).not.toHaveBeenCalled();
    expect(deps.state.tickets['ABC-1']).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining('Fix rejected after review'),
    });
  });

  it('ambiguous repo: comments the candidates and hands back without a run', async () => {
    deps.jira.getIssueForRun.mockResolvedValue(issueBase);
    (deps.carrotConfig as never as { getConfig: ReturnType<typeof vi.fn> }).getConfig.mockResolvedValue({
      prReview: true,
      jiraProjects: ['ABC'],
    });
    provider().listRepos.mockResolvedValue([
      { projectKey: 'P', slug: 'api' },
      { projectKey: 'P', slug: 'web' },
    ]);
    (deps.repoPicker as never as { pick: ReturnType<typeof vi.fn> }).pick.mockResolvedValue({ repo: null, usage: [] });
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect(pi().implement).not.toHaveBeenCalled();
    expect(deps.jira.addComment).toHaveBeenCalledWith('ABC-1', expect.stringContaining('api'));
    expect(deps.jira.addComment).toHaveBeenCalledWith('ABC-1', expect.stringContaining('web'));
    expect(deps.jira.assign).toHaveBeenCalledWith('ABC-1', { accountId: 'lead', displayName: 'Lead' });
  });

  it('applies the configured transition by name, case-insensitive', async () => {
    deps.jira.getIssueForRun.mockResolvedValue(issueBase);
    (deps.carrotConfig as never as { getConfig: ReturnType<typeof vi.fn> }).getConfig.mockResolvedValue({
      prReview: true,
      jiraProjects: ['ABC'],
      jiraDoneTransition: 'in review',
    });
    deps.jira.getTransitions.mockResolvedValue([{ id: '31', name: 'In Review' }]);
    git().execGit.mockImplementation((args: string[]) => (args[0] === 'status' ? ' M a.ts' : ''));
    const svc = new TicketService(deps);
    await svc.init();
    await svc.pollTickets();
    expect(deps.jira.transition).toHaveBeenCalledWith('ABC-1', '31');
  });
});
