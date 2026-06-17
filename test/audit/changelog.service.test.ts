import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChangelogService, sanitizeChangelogInput } from '../../src/audit/changelog.service';
import type { NpmRegistryClient } from '../../src/audit/npm-registry.client';
import type { LlmClient } from '../../src/reviewer/llm-client';
import type { IFixProposal, IAuditVulnGroup } from '../../src/audit/audit.types';

const makeGroup = (ghsaId: string): IAuditVulnGroup => ({
  ghsaId, title: `Vuln ${ghsaId}`, cwe: 'CWE-1234', url: '', packages: [],
});

describe('sanitizeChangelogInput', () => {
  it('strips HTML tags', () => {
    expect(sanitizeChangelogInput('Hello <script>alert("xss")</script> world')).toBe('Hello  world');
  });

  it('strips markdown images', () => {
    expect(sanitizeChangelogInput('Text ![alt](http://evil.com/img.png) more')).toBe('Text  more');
  });

  it('converts markdown links to text only', () => {
    expect(sanitizeChangelogInput('See [docs](http://example.com) here')).toBe('See docs here');
  });

  it('handles combined injection attempts', () => {
    const input = '<div>![img](http://x.com/y.png) [click](http://z.com)</div>';
    expect(sanitizeChangelogInput(input)).toBe('click');
  });
});

describe('ChangelogService', () => {
  const mockRegistry = {
    getRepoInfo: vi.fn(),
    getChangelog: vi.fn(),
  } as unknown as NpmRegistryClient;

  const mockSummarizer = {
    chat: vi.fn(),
    name: 'TestSummarizer',
  } as unknown as LlmClient;

  let service: ChangelogService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new ChangelogService(mockRegistry, mockSummarizer);
  });

  it('returns summary with token counts for valid changelog', async () => {
    (mockRegistry.getRepoInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      repoUrl: 'https://github.com/owner/repo',
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...v2.0.0',
      changelogUrl: null,
    });
    (mockRegistry.getChangelog as ReturnType<typeof vi.fn>).mockResolvedValue('## v2.0.0\n- Breaking: removed foo\n- Fixed: security issue');
    (mockSummarizer.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: '- Removed foo (breaking)\n- Fixed security issue',
      inputTokens: 150,
      outputTokens: 30,
    });

    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-1111'), strategy: 'override', overrideKey: 'pkg@<2.0.0', overrideVersion: '2.0.0', currentVersion: '1.0.0', dir: '.' },
    ];

    const summaries = await service.summarizeProposals(proposals);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toContain('Removed foo');
    expect(summaries[0].tokens).toEqual({ input: 150, output: 30 });
    expect(summaries[0].compareUrl).toBe('https://github.com/owner/repo/compare/v1.0.0...v2.0.0');
  });

  it('returns skipReason no-changelog when changelog is null', async () => {
    (mockRegistry.getRepoInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ repoUrl: null, compareUrl: null, changelogUrl: null });
    (mockRegistry.getChangelog as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-1111'), strategy: 'upgrade', upgradePackage: 'pkg', upgradeVersion: '2.0.0', currentVersion: '1.0.0', dir: '.' },
    ];
    const summaries = await service.summarizeProposals(proposals);
    expect(summaries[0].skipReason).toBe('no-changelog');
    expect(summaries[0].summary).toBeNull();
  });

  it('returns skipReason too-large when content exceeds 20k tokens', async () => {
    (mockRegistry.getRepoInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ repoUrl: null, compareUrl: null, changelogUrl: null });
    (mockRegistry.getChangelog as ReturnType<typeof vi.fn>).mockResolvedValue('x'.repeat(100_000));

    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-1111'), strategy: 'upgrade', upgradePackage: 'pkg', upgradeVersion: '2.0.0', currentVersion: '1.0.0', dir: '.' },
    ];
    const summaries = await service.summarizeProposals(proposals);
    expect(summaries[0].skipReason).toBe('too-large');
  });

  it('returns skipReason no-summarizer when summarizer is null', async () => {
    const noSummarizerService = new ChangelogService(mockRegistry, null);
    (mockRegistry.getRepoInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ repoUrl: null, compareUrl: null, changelogUrl: null });
    (mockRegistry.getChangelog as ReturnType<typeof vi.fn>).mockResolvedValue('Some changelog content');

    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-1111'), strategy: 'override', overrideKey: 'pkg@<2.0.0', overrideVersion: '2.0.0', currentVersion: '1.0.0', dir: '.' },
    ];
    const summaries = await noSummarizerService.summarizeProposals(proposals);
    expect(summaries[0].skipReason).toBe('no-summarizer');
  });

  it('deduplicates proposals with same package and versions', async () => {
    (mockRegistry.getRepoInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ repoUrl: null, compareUrl: null, changelogUrl: null });
    (mockRegistry.getChangelog as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-1111'), strategy: 'override', overrideKey: 'pkg@<2.0.0', overrideVersion: '2.0.0', currentVersion: '1.0.0', dir: '.' },
      { vulnGroup: makeGroup('GHSA-2222'), strategy: 'override', overrideKey: 'pkg@<2.0.0', overrideVersion: '2.0.0', currentVersion: '1.0.0', dir: 'frontend' },
    ];
    const summaries = await service.summarizeProposals(proposals);
    expect(summaries).toHaveLength(1);
  });

  it('skips proposals without currentVersion', async () => {
    const proposals: IFixProposal[] = [
      { vulnGroup: makeGroup('GHSA-1111'), strategy: 'override', overrideKey: 'pkg@<2.0.0', overrideVersion: '2.0.0', dir: '.' },
    ];
    const summaries = await service.summarizeProposals(proposals);
    expect(summaries).toHaveLength(0);
  });
});
