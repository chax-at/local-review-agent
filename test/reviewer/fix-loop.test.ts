import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  runFixValidationLoop,
  resolveLintScript,
  runLintAndFixErrors,
  type IFixLoopDeps,
} from '../../src/reviewer/fix-loop';
import type { IModelUsage } from '../../src/types';

const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;

function deps(overrides: Partial<IFixLoopDeps> = {}): IFixLoopDeps {
  const pi = { fix: vi.fn().mockReturnValue({ summary: 'revised', usage: { inputTokens: 1, outputTokens: 1 } }) };
  return {
    primaryModel: { name: 'M', pi: pi as never, roles: ['generic'], inputCostPer1M: 0, outputCostPer1M: 0 },
    validator: {
      hasModels: true,
      modelNames: ['V'],
      validateFix: vi.fn().mockResolvedValue({ approved: true, summary: 'ok', usage: [] }),
      summarizeFailure: vi.fn().mockResolvedValue({ summary: 'not good', usage: [] }),
      generateRejectionPrompt: vi.fn().mockResolvedValue({ prompt: '', usage: [] }),
    } as never,
    toModelUsage: (rm, usage) => ({
      modelName: rm.name,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costEur: 0,
    }),
    label: 'ABC-1',
    ...overrides,
  };
}

describe('runFixValidationLoop', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it('skips validation entirely when the validator has no models', async () => {
    const d = deps({ validator: { hasModels: false } as never });
    const result = await runFixValidationLoop(d, 'req', '', '/repo', undefined, false);
    expect(result).toEqual({ earlyReturn: null, usage: [] });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('returns "No changes were needed." when the working tree is clean', async () => {
    execSyncMock.mockReturnValueOnce('');
    const result = await runFixValidationLoop(deps(), 'req', '', '/repo', undefined, false);
    expect(result.earlyReturn).toBe('No changes were needed.');
  });

  it('approves on round 1 and returns no early return', async () => {
    execSyncMock.mockReturnValueOnce(' M src/a.ts').mockReturnValueOnce('diff --git a/src/a.ts');
    const d = deps();
    const result = await runFixValidationLoop(d, 'req', '', '/repo', undefined, false);
    expect(result.earlyReturn).toBeNull();
    expect((d.validator as never as { validateFix: ReturnType<typeof vi.fn> }).validateFix).toHaveBeenCalledWith(
      'req',
      'diff --git a/src/a.ts',
    );
  });

  it('after 3 rejected rounds resets the tree and returns the failure summary', async () => {
    // Each round: status, diff. Rounds 1 and 2 also run checkout + clean before pi revises.
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') return ' M src/a.ts';
      if (cmd === 'git diff') return 'diff';
      return '';
    });
    const d = deps();
    (d.validator as never as { validateFix: ReturnType<typeof vi.fn> }).validateFix.mockResolvedValue({
      approved: false,
      summary: 'wrong',
      usage: [],
    });
    const result = await runFixValidationLoop(d, 'req', 'orig', '/repo', undefined, false);
    expect(result.earlyReturn).toBe('Fix rejected after review: not good');
    const pi = d.primaryModel!.pi as never as { fix: ReturnType<typeof vi.fn> };
    expect(pi.fix).toHaveBeenCalledTimes(2);
    expect(execSyncMock.mock.calls.map((c) => c[0])).toContain('git checkout -- .');
  });

  it('appends a suggested fix prompt when generateFixPrompts is true and the prompt is non-empty', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') return ' M src/a.ts';
      if (cmd === 'git diff') return 'diff';
      return '';
    });
    const d = deps();
    const validator = d.validator as never as {
      validateFix: ReturnType<typeof vi.fn>;
      generateRejectionPrompt: ReturnType<typeof vi.fn>;
    };
    validator.validateFix.mockResolvedValue({ approved: false, summary: 'wrong', usage: [] });
    validator.generateRejectionPrompt.mockResolvedValue({ prompt: 'DO THIS', usage: [] });
    const result = await runFixValidationLoop(d, 'req', 'orig', '/repo', undefined, true);
    expect(validator.generateRejectionPrompt).toHaveBeenCalledWith('req', 'diff', [
      'Round 1: wrong',
      'Round 2: wrong',
      'Round 3: wrong',
    ]);
    expect(result.earlyReturn).toBe(
      'Fix rejected after review: not good\n\n---\n**Suggested fix prompt:**\n```\nDO THIS\n```',
    );
  });

  it('omits the suggested fix prompt when generateRejectionPrompt rejects', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') return ' M src/a.ts';
      if (cmd === 'git diff') return 'diff';
      return '';
    });
    const d = deps();
    const validator = d.validator as never as {
      validateFix: ReturnType<typeof vi.fn>;
      generateRejectionPrompt: ReturnType<typeof vi.fn>;
    };
    validator.validateFix.mockResolvedValue({ approved: false, summary: 'wrong', usage: [] });
    validator.generateRejectionPrompt.mockRejectedValue(new Error('boom'));
    const result = await runFixValidationLoop(d, 'req', 'orig', '/repo', undefined, true);
    expect(result.earlyReturn).toBe('Fix rejected after review: not good');
  });

  it('breaks after round 1 without revising when there is no primary model', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') return ' M src/a.ts';
      if (cmd === 'git diff') return 'diff';
      return '';
    });
    const d = deps({ primaryModel: null });
    const validator = d.validator as never as {
      validateFix: ReturnType<typeof vi.fn>;
      summarizeFailure: ReturnType<typeof vi.fn>;
    };
    validator.validateFix.mockResolvedValue({ approved: false, summary: 'wrong', usage: [] });
    const result = await runFixValidationLoop(d, 'req', 'orig', '/repo', undefined, false);
    expect(result.earlyReturn).toBe('Fix rejected after review: not good');
    expect(validator.summarizeFailure).toHaveBeenCalledWith(['Round 1: wrong']);
    expect(execSyncMock.mock.calls.filter((c) => c[0] === 'git diff')).toHaveLength(1);
  });
});

describe('resolveLintScript', () => {
  it('prefers ci:lint, then ci:stylecheck, then lint; null without package.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-loop-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'x', 'ci:stylecheck': 'y' } }),
      );
      expect(resolveLintScript(dir)).toBe('ci:stylecheck');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'x', 'ci:lint': 'z' } }));
      expect(resolveLintScript(dir)).toBe('ci:lint');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
      expect(resolveLintScript(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(resolveLintScript(path.join(dir, 'gone'))).toBeNull();
  });
});

describe('runLintAndFixErrors', () => {
  it('returns an empty result and touches nothing when there is no primary model', () => {
    const usageOut: IModelUsage[] = [];
    const result = runLintAndFixErrors(deps({ primaryModel: null }), '/repo', 'diff', usageOut);
    expect(result).toEqual({ failed: false, output: '' });
    expect(usageOut).toHaveLength(0);
  });

  it('runs pi.fix once with the lint output and pushes usage when lint fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-loop-lint-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
      const runLintMock = vi.fn().mockReturnValue({ failed: true, output: 'ERR' });
      const fixMock = vi.fn().mockReturnValue({ summary: 'fixed lint', usage: { inputTokens: 2, outputTokens: 3 } });
      const d = deps();
      d.primaryModel = { ...d.primaryModel!, pi: { fix: fixMock, runLint: runLintMock } as never };
      const usageOut: IModelUsage[] = [];
      const result = runLintAndFixErrors(d, dir, 'diff', usageOut, 'image');
      expect(runLintMock).toHaveBeenCalledWith(dir, 'lint', 'image');
      expect(fixMock).toHaveBeenCalledTimes(1);
      expect(fixMock.mock.calls[0][2]).toContain('ERR');
      expect(usageOut).toHaveLength(1);
      expect(result).toEqual({ failed: true, output: 'ERR' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not call pi.fix when the lint script passes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-loop-lint-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
      const runLintMock = vi.fn().mockReturnValue({ failed: false, output: '' });
      const fixMock = vi.fn();
      const d = deps();
      d.primaryModel = { ...d.primaryModel!, pi: { fix: fixMock, runLint: runLintMock } as never };
      const usageOut: IModelUsage[] = [];
      const result = runLintAndFixErrors(d, dir, 'diff', usageOut);
      expect(fixMock).not.toHaveBeenCalled();
      expect(usageOut).toHaveLength(0);
      expect(result).toEqual({ failed: false, output: '' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
