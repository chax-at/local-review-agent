import { describe, it, expect } from 'vitest';
import config from '../../src/safe-config';

describe('model config', () => {
  it('exposes Review and Model1-4 blocks with expected defaults', () => {
    expect(config.get('Review.MaxFileLines')).toBe(1000);
    expect(config.get('Review.MaxDiffLines')).toBe(5000);
    expect(config.get('Model1.Review')).toBe(false);
    expect(config.get('Model4.MaxTokenParam')).toBe('max_completion_tokens');
  });

  it('defaults every model Roles to "generic"', () => {
    expect(config.get('Model1.Roles')).toBe('generic');
    expect(config.get('Model2.Roles')).toBe('generic');
    expect(config.get('Model3.Roles')).toBe('generic');
    expect(config.get('Model4.Roles')).toBe('generic');
  });
});
