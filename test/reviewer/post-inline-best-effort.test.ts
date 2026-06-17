import { describe, it, expect, vi } from 'vitest';
import { postInlineCommentsBestEffort } from '../../src/reviewer/reviewer.service';
import type { IInlineCommentInput } from '../../src/provider/provider.types';

const input = (over: Partial<IInlineCommentInput> = {}): IInlineCommentInput => ({
  text: 'comment',
  path: 'a.ts',
  line: 1,
  lineKind: 'added',
  ...over,
});

describe('postInlineCommentsBestEffort', () => {
  it('posts every input when none fail', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const inputs = [input({ line: 1 }), input({ line: 2 }), input({ line: 3 })];
    const result = await postInlineCommentsBestEffort(inputs, post);
    expect(result).toEqual({ posted: 3, failed: 0 });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('continues past a failing post and still attempts the rest', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('422 out of diff'))
      .mockResolvedValueOnce(undefined);
    const inputs = [input({ line: 1 }), input({ line: 2 }), input({ line: 3 })];
    const result = await postInlineCommentsBestEffort(inputs, post);
    expect(result).toEqual({ posted: 2, failed: 1 });
    expect(post).toHaveBeenCalledTimes(3); // the failure did not abort the loop
  });

  it('reports zero posted when every post fails', async () => {
    const post = vi.fn().mockRejectedValue(new Error('provider down'));
    const inputs = [input({ line: 1 }), input({ line: 2 })];
    const result = await postInlineCommentsBestEffort(inputs, post);
    expect(result).toEqual({ posted: 0, failed: 2 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('does nothing for an empty list', async () => {
    const post = vi.fn();
    const result = await postInlineCommentsBestEffort([], post);
    expect(result).toEqual({ posted: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});
