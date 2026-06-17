import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { LlmClient, ILlmResponse } from './llm-client';
import type { IAuthoredFinding, IModelUsage } from '../types';
import { DedupClustersSchema, dedupClustersJsonSchema, parseWithSchema } from './llm-schemas';

export interface IDedupeResult {
  /** Findings after collapsing same-run duplicates. Merged findings carry `contributingAuthors`. */
  findings: IAuthoredFinding[];
  usage: IModelUsage[];
  /** Number of clusters that merged 2+ findings into one (for logging). */
  mergedClusters: number;
}

/** Severity ordering for picking a merged finding's anchor (higher wins). */
const SEVERITY_RANK: Record<IAuthoredFinding['severity'], number> = {
  concern: 3,
  suggestion: 2,
  note: 1,
};

/** Max chars of each finding comment sent to the dedup model (comments are usually short). */
const MAX_COMMENT_CHARS = 1000;

/**
 * The dedicated single-LLM pass that decides duplicate-or-not for findings
 * produced within ONE review run, BEFORE the validation council sees them — so
 * the council never votes on duplication. Several review models often flag the
 * same issue; this collapses those into one finding whose comment merges every
 * triggering reason (no information lost).
 *
 * Findings are compared per file (duplicates are same-file), so files with a
 * single finding need no call. Fail-safe throughout: any model or parse error
 * keeps that file's findings unmerged — a finding is never dropped because
 * dedup failed.
 */
export class FindingDeduplicator {
  constructor(private readonly llm: LlmClient | null) {}

  public get isEnabled(): boolean {
    return this.llm !== null;
  }

  public async dedupe(findings: IAuthoredFinding[]): Promise<IDedupeResult> {
    if (!this.llm || findings.length < 2) {
      return { findings, usage: [], mergedClusters: 0 };
    }

    // Group by file, preserving first-seen order.
    const byFile = new Map<string, IAuthoredFinding[]>();
    for (const f of findings) {
      const list = byFile.get(f.filePath);
      if (list) list.push(f);
      else byFile.set(f.filePath, [f]);
    }

    // Per-file dedup calls are independent — run them in parallel. dedupeFile
    // catches its own errors and returns the file's findings unmerged, so one
    // broken file can't poison the batch; allSettled is a belt-and-braces guard
    // and recovers the input on the (unexpected) rejection path.
    const fileGroups = [...byFile.values()];
    const settled = await Promise.allSettled(fileGroups.map((g) => this.dedupeFile(g)));

    const out: IAuthoredFinding[] = [];
    const usage: IModelUsage[] = [];
    let mergedClusters = 0;
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status !== 'fulfilled') {
        LogSink.warn(`Dedup: per-file dedup threw unexpectedly, keeping findings: ${s.reason}`, TraceTags.PI);
        out.push(...fileGroups[i]);
        continue;
      }
      out.push(...s.value.findings);
      usage.push(...s.value.usage);
      mergedClusters += s.value.mergedClusters;
    }

    return { findings: out, usage, mergedClusters };
  }

  /** Dedup one file's findings. Files with <2 findings short-circuit (no call). */
  private async dedupeFile(fileFindings: IAuthoredFinding[]): Promise<IDedupeResult> {
    if (fileFindings.length < 2) {
      return { findings: fileFindings, usage: [], mergedClusters: 0 };
    }
    const { filePath } = fileFindings[0];

    let response: ILlmResponse;
    try {
      response = await this.llm!.chat(this.systemPrompt(filePath), this.userMessage(filePath, fileFindings), {
        jsonMode: true,
        jsonSchema: dedupClustersJsonSchema,
      });
    } catch (err) {
      LogSink.warn(`Dedup ${this.llm!.name} failed for ${filePath}, keeping all findings: ${err}`, TraceTags.PI);
      return { findings: fileFindings, usage: [], mergedClusters: 0 };
    }

    const usage = [this.trackUsage(response)];
    const parsed = parseWithSchema(response.content, DedupClustersSchema);
    if (!parsed) {
      LogSink.warn(
        `Dedup ${this.llm!.name} returned unparseable response for ${filePath}, keeping all findings`,
        TraceTags.PI,
      );
      return { findings: fileFindings, usage, mergedClusters: 0 };
    }

    const { findings, mergedClusters } = this.applyClusters(fileFindings, parsed.clusters);
    return { findings, usage, mergedClusters };
  }

  /**
   * Turn the model's clusters into the deduped finding list. Robust to any
   * model output: out-of-range and repeated indexes are ignored, and any
   * finding the model failed to assign survives as its own singleton — every
   * input finding appears in the output exactly once.
   */
  private applyClusters(
    fileFindings: IAuthoredFinding[],
    clusters: Array<{ memberIndexes: number[]; mergedComment: string }>,
  ): { findings: IAuthoredFinding[]; mergedClusters: number } {
    const n = fileFindings.length;
    const assigned = new Array<boolean>(n).fill(false);
    const placed: Array<{ order: number; finding: IAuthoredFinding }> = [];
    let mergedClusters = 0;

    for (const c of clusters) {
      const idxs = [...new Set(c.memberIndexes)].filter((i) => Number.isInteger(i) && i >= 0 && i < n && !assigned[i]);
      if (idxs.length === 0) continue;
      for (const i of idxs) assigned[i] = true;
      if (idxs.length === 1) {
        placed.push({ order: idxs[0], finding: fileFindings[idxs[0]] });
      } else {
        placed.push({
          order: Math.min(...idxs),
          finding: this.mergeCluster(
            idxs.map((i) => fileFindings[i]),
            c.mergedComment,
          ),
        });
        mergedClusters++;
      }
    }

    // Any finding the model never assigned to a cluster survives unmerged.
    for (let i = 0; i < n; i++) {
      if (!assigned[i]) placed.push({ order: i, finding: fileFindings[i] });
    }

    placed.sort((a, b) => a.order - b.order);
    return { findings: placed.map((p) => p.finding), mergedClusters };
  }

  /**
   * Build the merged finding from a cluster's members. The anchor (file/line/
   * severity) is the highest-severity member, earliest line breaking a tie —
   * decided here, not by the model, so it is deterministic. The comment is the
   * model's merged text, falling back to the joined member comments if empty.
   */
  private mergeCluster(members: IAuthoredFinding[], mergedComment: string): IAuthoredFinding {
    const anchor = [...members].sort((a, b) => {
      const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      return bySeverity !== 0 ? bySeverity : a.line - b.line;
    })[0];

    const contributingAuthors = [...new Set(members.map((m) => m.author))];
    const comment = mergedComment.trim() || members.map((m) => m.comment).join('\n\n');

    return {
      filePath: anchor.filePath,
      line: anchor.line,
      severity: anchor.severity,
      comment,
      author: anchor.author,
      contributingAuthors,
    };
  }

  private systemPrompt(filePath: string): string {
    return [
      `You are deduplicating automated code-review findings on \`${filePath}\`.`,
      'Several reviewers may have independently flagged the SAME underlying issue, sometimes with different wording, line numbers, or severity.',
      'Group findings that describe the SAME issue into one cluster; findings about DIFFERENT issues belong in separate clusters.',
      'Assign every finding index to exactly one cluster.',
      'For a cluster that merges 2+ findings, write one `mergedComment` that combines BOTH reasons for triggering so no information is lost.',
      'For a single-finding cluster, set mergedComment to "".',
      'Be conservative: only merge findings that are genuinely the same issue. When in doubt, keep them separate.',
      'Return JSON: { "clusters": [ { "memberIndexes": [0, 2], "mergedComment": "..." }, { "memberIndexes": [1], "mergedComment": "" } ] }',
    ].join('\n');
  }

  private userMessage(filePath: string, fileFindings: IAuthoredFinding[]): string {
    const items = fileFindings.map((f, i) => ({
      index: i,
      line: f.line,
      severity: f.severity,
      comment: f.comment.slice(0, MAX_COMMENT_CHARS),
    }));
    return [`## Findings on \`${filePath}\`:`, JSON.stringify(items)].join('\n');
  }

  private trackUsage(response: ILlmResponse): IModelUsage {
    const llm = this.llm!;
    const cost =
      (response.inputTokens / 1_000_000) * llm.inputCostPer1M +
      (response.outputTokens / 1_000_000) * llm.outputCostPer1M;
    return {
      modelName: llm.name,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costEur: cost,
    };
  }
}
