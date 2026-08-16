import type { IAuthoredFinding } from '../types';

/**
 * Render which model(s) and persona(s) produced a finding, for the inline
 * comment. Personas are grouped per model, models keep first-seen order:
 *   single finding            → "R1 (security)" or "R1"
 *   merged from two models    → "R1 (security), R2 (generic)"
 *   merged personas, one model → "R1 (security, generic)"
 * Returns '' when there is nothing to attribute (no author and no sources).
 */
export function formatFindingAttribution(finding: IAuthoredFinding): string {
  const sources = finding.sources ?? [{ author: finding.author, persona: finding.persona }];

  const personasByAuthor = new Map<string, string[]>();
  for (const s of sources) {
    if (!s.author) continue;
    const personas = personasByAuthor.get(s.author) ?? [];
    if (s.persona && !personas.includes(s.persona)) personas.push(s.persona);
    personasByAuthor.set(s.author, personas);
  }

  return [...personasByAuthor.entries()]
    .map(([author, personas]) => (personas.length > 0 ? `${author} (${personas.join(', ')})` : author))
    .join(', ');
}

/** The ready-to-append markdown line for an inline comment, or '' when unattributable. */
export function attributionSuffix(finding: IAuthoredFinding): string {
  const label = formatFindingAttribution(finding);
  return label ? `\n\n*Found by ${label}*` : '';
}
