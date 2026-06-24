import { describe, it, expect, vi } from 'vitest';
import { executeMentionTool } from '../../src/poller/mention-executor';

describe('executeMentionTool', () => {
  const makeDeps = () => ({
    reviewer: {
      fixPr: vi.fn().mockResolvedValue({ success: true, message: 'fix done' }),
      autofixPr: vi.fn().mockResolvedValue({ success: true, message: 'autofix done' }),
      reviewPr: vi.fn(),
    },
    handleRevert: vi.fn().mockResolvedValue('reverted'),
    postReply: vi.fn(),
    pr: { project: 'P', slug: 'R', prId: 1, sourceBranch: 'feature', targetBranch: 'main' },
  }) as any;

  const baseMention = { prId: 1, repoKey: 'P/R', commentId: 10 };
  const route = (tool: string, message = '') => ({ tool, message, reasoning: 'test' });

  it('dispatches fix to reviewer.fixPr', async () => {
    const deps = makeDeps();
    const result = await executeMentionTool(route('fix', 'add null check') as any, baseMention, deps);
    expect(deps.reviewer.fixPr).toHaveBeenCalled();
    expect(result).toEqual({ success: true, message: 'fix done' });
  });

  it('dispatches autofix to reviewer.autofixPr', async () => {
    const deps = makeDeps();
    await executeMentionTool(route('autofix') as any, baseMention, deps);
    expect(deps.reviewer.autofixPr).toHaveBeenCalled();
  });

  it('dispatches revert to handleRevert', async () => {
    const deps = makeDeps();
    const result = await executeMentionTool(route('revert', 'abc123') as any, baseMention, deps);
    expect(deps.handleRevert).toHaveBeenCalledWith('abc123');
    expect(result).toEqual({ success: true, message: 'reverted' });
  });

  it('dispatches review to reviewer.reviewPr', async () => {
    const deps = makeDeps();
    await executeMentionTool(route('review') as any, baseMention, deps);
    expect(deps.reviewer.reviewPr).toHaveBeenCalled();
  });

  it('dispatches explain to postReply', async () => {
    const deps = makeDeps();
    await executeMentionTool(route('explain', 'Because of X') as any, baseMention, deps);
    expect(deps.postReply).toHaveBeenCalledWith(expect.stringContaining('Because of X'));
  });

  it('dispatches reply to postReply', async () => {
    const deps = makeDeps();
    await executeMentionTool(route('reply', 'Noted, thanks') as any, baseMention, deps);
    expect(deps.postReply).toHaveBeenCalledWith(expect.stringContaining('Noted, thanks'));
  });

  it('returns null for ignore', async () => {
    const deps = makeDeps();
    const result = await executeMentionTool(route('ignore') as any, baseMention, deps);
    expect(result).toBeNull();
    expect(deps.postReply).not.toHaveBeenCalled();
  });
});
