// test/bootstrap.test.ts
import { describe, it, expect, vi } from 'vitest';
import { requireNonEmpty } from '../src/bootstrap';

describe('requireNonEmpty', () => {
  it('returns the value when non-empty', () => {
    expect(requireNonEmpty('abc', 'X')).toBe('abc');
  });

  it('calls process.exit(1) when blank', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requireNonEmpty('   ', 'X');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('calls process.exit(1) when empty string', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requireNonEmpty('', 'X');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
