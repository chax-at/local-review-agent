import { describe, it, expect } from 'vitest';
import { SCANNER_ELIGIBLE_PERSONAS, scannerFindingsForRole } from '../../src/reviewer/reviewer.service';

describe('SCANNER_ELIGIBLE_PERSONAS', () => {
  it('includes security and generic, excludes the rest', () => {
    expect(SCANNER_ELIGIBLE_PERSONAS.has('security')).toBe(true);
    expect(SCANNER_ELIGIBLE_PERSONAS.has('generic')).toBe(true);
    expect(SCANNER_ELIGIBLE_PERSONAS.has('correctness')).toBe(false);
    expect(SCANNER_ELIGIBLE_PERSONAS.has('readability')).toBe(false);
    expect(SCANNER_ELIGIBLE_PERSONAS.has('vegetable-police')).toBe(false);
  });
});

describe('scannerFindingsForRole', () => {
  it('returns the findings for the security persona', () => {
    expect(scannerFindingsForRole('security', '## Semgrep\n- finding')).toBe('## Semgrep\n- finding');
  });

  it('returns the findings for the generic persona', () => {
    expect(scannerFindingsForRole('generic', '## Semgrep\n- finding')).toBe('## Semgrep\n- finding');
  });

  it('withholds findings from correctness/readability/vegetable-police', () => {
    expect(scannerFindingsForRole('correctness', '## Semgrep\n- finding')).toBeNull();
    expect(scannerFindingsForRole('readability', '## Semgrep\n- finding')).toBeNull();
    expect(scannerFindingsForRole('vegetable-police', '## Semgrep\n- finding')).toBeNull();
  });

  it('returns null when there are no scanner findings at all', () => {
    expect(scannerFindingsForRole('security', '')).toBeNull();
    expect(scannerFindingsForRole('security', '   ')).toBeNull();
  });
});
