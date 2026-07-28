import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';
import type { IReviewFinding } from '../types';
import { BOT_TEMP_DIR } from '../constants';
import { ensurePiRunnerForBase } from './pi-runner-image';
import { buildReviewPrompt, PERSONA_DIRECTIVES } from './personas';

const SEVERITY_MAP: Record<string, IReviewFinding['severity']> = {
  error: 'concern',
  critical: 'concern',
  high: 'concern',
  concern: 'concern',
  warning: 'suggestion',
  medium: 'suggestion',
  warn: 'suggestion',
  suggestion: 'suggestion',
  info: 'note',
  low: 'note',
  minor: 'note',
  note: 'note',
};

function normalizeSeverity(severity: string): IReviewFinding['severity'] {
  return SEVERITY_MAP[severity.toLowerCase()] ?? 'note';
}

/**
 * Largest pi log read into a string. V8 caps strings at ~512 MB, so a whole-file
 * read of a very long model trace throws ERR_STRING_TOO_LONG and loses the run.
 * Above this cap only the tail is parsed — findings live in the trailing
 * message_end events, so a truncated tail still beats a failed review.
 */
export const MAX_PI_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * Create a run directory under this instance's temp dir. The temp dir is
 * per-process and recreated each poll cycle, so make sure it exists rather than
 * relying on the cycle having run first.
 */
function makeRunDir(prefix: string): string {
  fs.mkdirSync(BOT_TEMP_DIR, { recursive: true });
  return fs.mkdtempSync(path.join(BOT_TEMP_DIR, prefix));
}

/**
 * Read the container's log file, falling back to its last {@link MAX_PI_OUTPUT_BYTES}
 * bytes when the file is too big to hold in a single string. Read errors
 * (including ENOENT) propagate so callers can retry.
 */
export function readPiOutput(file: string, maxBytes: number = MAX_PI_OUTPUT_BYTES): string {
  const size = fs.statSync(file).size;
  if (size <= maxBytes) return fs.readFileSync(file, 'utf-8');

  LogSink.warn(`pi output is ${size} bytes; parsing only the last ${maxBytes} bytes`, TraceTags.PI);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const text = buf.toString('utf-8');
    // Drop the leading partial line — every parser downstream splits on newlines.
    const firstNewline = text.indexOf('\n');
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Explain why the container's log could not be read. The read failing is not
 * proof that pi wrote nothing: the workspace may have been deleted mid-run, or
 * the file may be present but too large to load.
 */
export function describeOutputReadFailure(
  err: NodeJS.ErrnoException | null,
  workspaceHost: string,
  outHost: string,
): string {
  const code = err?.code ?? 'unknown';
  const message = err?.message ?? 'no error captured';

  if (!fs.existsSync(workspaceHost)) {
    return `workspace directory ${workspaceHost} no longer exists — it was removed while the container was running (${code}); the container wrote to an unlinked file`;
  }

  let size: number | null = null;
  try {
    size = fs.statSync(outHost).size;
  } catch {
    size = null;
  }

  if (size === null) {
    let siblings = '(unreadable)';
    try {
      siblings = fs.readdirSync(workspaceHost).join(', ') || '(empty)';
    } catch {
      /* keep placeholder */
    }
    return `${outHost} was never created (${code}); workspace still holds: ${siblings}`;
  }

  return `${outHost} exists (${size} bytes) but could not be read: ${code}: ${message}`;
}

export function parsePiFindings(output: string): IReviewFinding[] {
  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    LogSink.warn('Failed to parse pi output as JSON', TraceTags.PI);
    appendErrorLog([
      'context: review model returned text that is not valid findings JSON (0 findings extracted)',
      `detail: ${err instanceof Error ? err.message : String(err)}`,
      '--- offending model output (truncated to 4000 chars) ---',
      output.trim().slice(0, 4000) || '(empty)',
    ]);
    return [];
  }

  if (!parsed.findings || !Array.isArray(parsed.findings)) {
    LogSink.warn('pi output has no findings array', TraceTags.PI);
    appendErrorLog([
      'context: review model returned JSON with no findings array (0 findings extracted)',
      '--- offending model output (truncated to 4000 chars) ---',
      output.trim().slice(0, 4000) || '(empty)',
    ]);
    return [];
  }

  const results: IReviewFinding[] = [];
  for (const f of parsed.findings) {
    if (typeof f.filePath !== 'string' || f.filePath === '') continue;
    if (typeof f.line !== 'number' || f.line < 1) continue;
    if (typeof f.comment !== 'string' || f.comment === '') continue;

    results.push({
      filePath: f.filePath,
      line: f.line,
      severity: normalizeSeverity(String(f.severity ?? 'info')),
      comment: f.comment,
    });
  }

  return results;
}

/** Separator used between chunk outputs inside a single container run */
const CHUNK_SEPARATOR = '===LGR_CHUNK_SEPARATOR===';

/** Buffer added to timeoutMs to account for Docker container startup overhead. */
const DOCKER_INSTALL_BUFFER_MS = 30000;

/** Extra time per chunk when batching reviews */
const PER_CHUNK_TIMEOUT_MS = 60000;

/** Synchronous sleep — dockerRun is sync, so it can't await between read retries. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Append a timestamped diagnostic block to data/error.log (best-effort).
 *
 * Failures here would otherwise surface only as a one-line `Warn` the operator
 * is unlikely to be watching, so the underlying detail is recorded to disk for
 * after-the-fact inspection. A logging failure must never mask the original
 * problem, so everything is swallowed.
 */
function appendErrorLog(lines: string[]): void {
  try {
    const dir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const block = [`===== ${new Date().toISOString()} =====`, ...lines, '', ''].join('\n');
    fs.appendFileSync(path.join(dir, 'error.log'), block);
  } catch {
    /* best-effort */
  }
}

/** Record a Docker-run failure with docker's own stdout/stderr + exit status. */
function appendDockerErrorLog(record: {
  context: string;
  command: string;
  exitStatus: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  detail: string;
}): void {
  appendErrorLog([
    `context: ${record.context}`,
    `detail: ${record.detail}`,
    `exit: status=${record.exitStatus ?? 'n/a'} signal=${record.signal ?? 'n/a'}`,
    `command: ${record.command}`,
    '--- docker stdout ---',
    record.stdout.trim() || '(empty)',
    '--- docker stderr ---',
    record.stderr.trim() || '(empty)',
  ]);
}

function extractTextContent(message: any): string | null {
  // pi returns content as an array of {type, text/thinking} objects
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (part.type === 'text' && part.text) return part.text;
    }
    return null;
  }
  // Fallback: content as string
  if (typeof message?.content === 'string') return message.content;
  return null;
}

export interface IPiTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function mergeUsage(a: IPiTokenUsage, b: IPiTokenUsage): IPiTokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/**
 * Build the shell snippet that runs the given npm script inside the lint
 * container. The container has `/repo` mounted (the cloned PR working tree).
 *
 * Pure function — exported separately from `runLint` so it can be unit-tested
 * without spawning Docker.
 */
export function buildLintScript(script: string): string {
  return `cd /repo && npm run ${script}`;
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return null;
}

function normalizeUsageObject(u: Record<string, unknown>): { input: number; output: number } | null {
  const input = pickNum(u, ['input', 'prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens']);
  const output = pickNum(u, ['output', 'completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']);
  if (input === null && output === null) return null;
  return { input: input ?? 0, output: output ?? 0 };
}

/**
 * Throws if pi produced no usable model response. Catches two failure modes
 * the chunk-tolerant batch script would otherwise treat as "no findings":
 *  - container-level failures (e.g. `pi: not found`, missing API key) that
 *    emit zero `message_end` events;
 *  - provider-level failures (e.g. a 404 from a base-URL/provider mismatch, or
 *    a 400 from a deprecated request parameter) where the assistant
 *    `message_end` carries `stopReason: 'error'` and empty content. A
 *    successful assistant response on any call is enough to pass.
 *
 * Only `role: 'assistant'` message_end events count. pi also emits a `user`
 * message_end (the echoed prompt) with no `stopReason` — treating that as
 * success masks an assistant turn that actually errored, degrading a hard
 * provider failure into a silent "no findings".
 */
export function assertPiProducedResponse(output: string): void {
  let lastError: string | null = null;
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t) as {
        type?: string;
        message?: { role?: string; stopReason?: string; errorMessage?: string };
      } | null;
      if (!e || e.type !== 'message_end' || e.message?.role !== 'assistant') continue;
      if (e.message?.stopReason === 'error') {
        lastError = e.message.errorMessage ?? 'unknown error';
        continue;
      }
      return;
    } catch {
      continue;
    }
  }
  if (lastError !== null) {
    throw new Error(`pi failed on every model call. Last error: ${lastError}`);
  }
  const head = output.trim().slice(0, 500);
  throw new Error(`pi did not produce a model response. Output: ${head || '(empty)'}`);
}

/** Sum token usage from pi JSONL (one `message_end` with `usage` per model call). */
export function aggregateUsageFromPiOutput(output: string): IPiTokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const event = JSON.parse(t) as { type?: string; usage?: unknown; message?: { usage?: unknown } };
      if (event.type !== 'message_end') continue;
      const raw = event.usage ?? event.message?.usage;
      if (!raw || typeof raw !== 'object') continue;
      const n = normalizeUsageObject(raw as Record<string, unknown>);
      if (n) {
        inputTokens += n.input;
        outputTokens += n.output;
      }
    } catch {
      continue;
    }
  }
  return { inputTokens, outputTokens };
}

export interface IPiReviewResult {
  findings: IReviewFinding[];
  usage: IPiTokenUsage;
}

function extractFindings(output: string): IReviewFinding[] {
  const lines = output.trim().split('\n');
  LogSink.debug(`pi output: ${lines.length} lines`, TraceTags.PI);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const text = extractTextContent(event.message);
        if (text) return parsePiFindings(text);
      }
      if (event.findings) {
        return parsePiFindings(lines[i]);
      }
    } catch {
      continue;
    }
  }

  return parsePiFindings(output);
}

/**
 * Map a pi provider to its API-key env var name, mirroring pi's own
 * `getApiKeyEnvVars`. Providers omitted here are not configured in this repo.
 */
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  'google-vertex': 'GOOGLE_CLOUD_API_KEY',
  openai: 'OPENAI_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
};

/**
 * Build the `-e KEY=VAL` docker args that hand pi its credentials.
 *
 * Each provider reads its key from a different env var, so the key is passed
 * under the name pi expects (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, ...).
 * Only `azure-openai-responses` consumes a configurable base URL
 * (`AZURE_OPENAI_BASE_URL`) and deployment name (`AZURE_OPENAI_MODEL`); every
 * other provider uses pi's built-in base, so `apiBase` is intentionally
 * ignored for them (the `--model` CLI flag carries the model id).
 */
export function buildProviderEnvArgs(
  provider: string,
  apiKey: string,
  apiBase: string,
  model: string,
): string[] {
  if (!apiKey) return [];
  const keyEnv = PROVIDER_API_KEY_ENV[provider] ?? 'AZURE_OPENAI_API_KEY';
  const args = ['-e', `${keyEnv}=${apiKey}`];
  if (provider === 'azure-openai-responses') {
    if (apiBase) args.push('-e', `AZURE_OPENAI_BASE_URL=${apiBase}`);
    args.push('-e', `AZURE_OPENAI_MODEL=${model}`);
  }
  return args;
}

export class PiService {
  private readonly model: string;
  private readonly provider: string;
  private readonly timeoutMs: number;
  private readonly dockerImage: string;
  private readonly apiKey: string;
  private readonly apiBase: string;

  constructor(
    model: string,
    provider: string,
    timeoutMs: number,
    dockerImage: string,
    apiKey: string,
    apiBase: string,
  ) {
    this.model = model;
    this.provider = provider;
    this.timeoutMs = timeoutMs;
    this.dockerImage = dockerImage;
    this.apiKey = apiKey;
    this.apiBase = apiBase;
  }

  public review(diffContent: string, codeStandards: string | null, dockerImageOverride?: string): IPiReviewResult {
    return this.reviewBatch([diffContent], codeStandards, null, dockerImageOverride);
  }

  /**
   * Review multiple diff chunks in a single Docker container.
   * Installs pi once, then loops over all chunks inside the container.
   */
  public reviewBatch(
    diffs: string[],
    codeStandards: string | null,
    existingComments: string | null,
    dockerImageOverride?: string,
    personaDirective: string = PERSONA_DIRECTIVES.generic,
  ): IPiReviewResult {
    const tmpDir = makeRunDir('pi-');
    try {
      for (let i = 0; i < diffs.length; i++) {
        fs.writeFileSync(path.join(tmpDir, `chunk-${i}.patch`), diffs[i]);
      }

      let standardsArg = '';
      if (codeStandards) {
        fs.writeFileSync(path.join(tmpDir, 'standards.md'), codeStandards);
        standardsArg = ' @/workspace/standards.md';
      }

      let commentsArg = '';
      if (existingComments && existingComments.trim()) {
        fs.writeFileSync(path.join(tmpDir, 'existing-comments.md'), existingComments);
        commentsArg = ' @/workspace/existing-comments.md';
      }

      const prompt = buildReviewPrompt(personaDirective, Boolean(commentsArg));

      const piBase = `pi --mode json --provider ${this.provider} --model ${this.model} --no-session --no-tools`;
      const script = this.buildBatchScript(piBase, standardsArg, commentsArg, prompt, diffs.length);
      fs.writeFileSync(path.join(tmpDir, 'run.sh'), script);

      LogSink.info(`Invoking pi for review (Docker, ${diffs.length} chunk(s))...`, TraceTags.PI);
      const timeout = this.timeoutMs + DOCKER_INSTALL_BUFFER_MS + diffs.length * PER_CHUNK_TIMEOUT_MS;
      const output = this.dockerRun({
        mounts: [{ host: tmpDir, container: '/workspace' }],
        imageOverride: dockerImageOverride,
        timeout,
      });

      assertPiProducedResponse(output);

      const usage = aggregateUsageFromPiOutput(output);

      // Split output by chunk separator and extract findings from each
      const chunkOutputs = output.split(CHUNK_SEPARATOR).filter((s) => s.trim());
      LogSink.debug(`Got ${chunkOutputs.length} chunk output(s) from container`, TraceTags.PI);

      const allFindings: IReviewFinding[] = [];
      for (const chunkOutput of chunkOutputs) {
        allFindings.push(...extractFindings(chunkOutput));
      }

      return { findings: allFindings, usage };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Run a project's npm-script lint inside the Docker container (NOT on the
   * host) so a malicious PR's package.json scripts cannot run arbitrary
   * commands on the bot host. Returns `{ failed, output }` matching the
   * existing host-execSync contract.
   *
   * The container has `/repo` mounted at the cloned PR's working tree
   * (read-write because npm may touch its cache). On non-zero exit, the
   * container's combined stdout+stderr is read back from the dockerRun
   * logfile and returned as the lint output.
   */
  public runLint(
    repoDir: string,
    lintScript: string,
    dockerImageOverride?: string,
  ): { failed: boolean; output: string } {
    const tmpDir = makeRunDir('pi-lint-');
    try {
      const cmd = buildLintScript(lintScript);
      // No `set -e`: the script's exit code is npm's exit code. Stderr is
      // merged into stdout so the dockerRun logfile contains everything.
      fs.writeFileSync(path.join(tmpDir, 'run.sh'), ['#!/bin/sh', `${cmd} 2>&1`].join('\n'));

      let failed = false;
      try {
        this.dockerRun({
          mounts: [
            { host: tmpDir, container: '/workspace' },
            { host: path.resolve(repoDir), container: '/repo' },
          ],
          workdir: '/repo',
          imageOverride: dockerImageOverride,
        });
      } catch {
        failed = true;
      }

      // Read the logfile dockerRun writes to (visible in tmpDir as 'lgr-pi-out.log').
      // On success: output is empty (matching the existing host-execSync contract,
      // which also discards lint stdout when the lint passes).
      let output = '';
      if (failed) {
        try {
          output = readPiOutput(path.join(tmpDir, 'lgr-pi-out.log')).slice(0, 5000);
        } catch {
          output = '(lint output unavailable)';
        }
      }

      return { failed, output };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  public fix(
    diffContent: string,
    repoDir: string,
    userMessage: string,
    dockerImageOverride?: string,
  ): { summary: string | null; usage: IPiTokenUsage } {
    const tmpDir = makeRunDir('pi-fix-');
    try {
      fs.writeFileSync(path.join(tmpDir, 'diff.patch'), diffContent);

      const prompt = [
        `Fix the following issue in the code: ${userMessage}`,
        'Use your edit and write tools to make the necessary changes.',
        'After fixing, output a brief summary of what you changed.',
      ].join(' ');

      const piCmd = `pi --mode json --provider ${this.provider} --model ${this.model} --no-session --tools read,write,edit,bash @/workspace/diff.patch`;
      fs.writeFileSync(path.join(tmpDir, 'run.sh'), this.buildScript(piCmd, prompt));

      LogSink.info('Invoking pi for fix (Docker)...', TraceTags.PI);
      const output = this.dockerRun({
        mounts: [
          { host: tmpDir, container: '/workspace' },
          { host: path.resolve(repoDir), container: '/repo' },
        ],
        workdir: '/repo',
        imageOverride: dockerImageOverride,
      });

      const usage = aggregateUsageFromPiOutput(output);

      const lines = output.trim().split('\n');
      LogSink.debug(`pi fix output: ${lines.length} lines`, TraceTags.PI);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const event = JSON.parse(lines[i]);
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const text = extractTextContent(event.message);
            if (text) return { summary: text, usage };
          }
        } catch {
          continue;
        }
      }

      return { summary: output.trim().slice(0, 500), usage };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private buildScript(piCmd: string, prompt: string): string {
    return ['#!/bin/sh', 'set -e', "PROMPT=$(cat <<'PROMPT_EOF'", prompt, 'PROMPT_EOF', ')', `${piCmd} "$PROMPT"`].join(
      '\n',
    );
  }

  private buildBatchScript(
    piBase: string,
    standardsArg: string,
    commentsArg: string,
    prompt: string,
    chunkCount: number,
  ): string {
    const lines = ['#!/bin/sh', 'set -e', "PROMPT=$(cat <<'PROMPT_EOF'", prompt, 'PROMPT_EOF', ')'];

    for (let i = 0; i < chunkCount; i++) {
      if (i > 0) lines.push(`echo "${CHUNK_SEPARATOR}"`);
      lines.push(`${piBase} @/workspace/chunk-${i}.patch${standardsArg}${commentsArg} "$PROMPT" || true`);
    }

    return lines.join('\n');
  }

  private dockerRun(opts: {
    mounts: Array<{ host: string; container: string; readonly?: boolean }>;
    workdir?: string;
    imageOverride?: string;
    timeout?: number;
  }): string {
    const workspaceHost = opts.mounts.find((m) => m.container === '/workspace')?.host ?? opts.mounts[0]?.host;
    if (!workspaceHost) {
      throw new Error('dockerRun requires a /workspace volume mount');
    }

    const outLogName = 'lgr-pi-out.log';
    const outHost = path.join(workspaceHost, outLogName);
    try {
      fs.unlinkSync(outHost);
    } catch {
      // ignore
    }

    // Write a tiny wrapper so pi JSONL goes to a file instead of the host↔docker pipe.
    // Huge model traces (reasoning, base64, etc.) can exceed pipe buffers and cause spawnSync ENOBUFS
    // even when maxBuffer is large; the container still completes successfully.
    fs.writeFileSync(
      path.join(workspaceHost, 'run-docker.sh'),
      ['#!/bin/sh', `sh /workspace/run.sh > /workspace/${outLogName} 2>&1`].join('\n'),
    );

    // When a per-repo override is set, derive a local lgr-pi-runner-derived
    // image from it (FROM <override> + npm install -g pi). The default tag
    // already has pi pre-installed.
    const image = opts.imageOverride ? ensurePiRunnerForBase(opts.imageOverride) : this.dockerImage;

    // Run as host user so files created in mounted volumes are deletable from
    // the host. HOME=/tmp gives npm a writable home for any read-only metadata
    // operations it performs (lockfile check, config). Pi is pre-installed in
    // the (possibly derived) runner image — no PATH override needed.
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const args = [
      'run',
      '--rm',
      '--user',
      `${uid}:${gid}`,
      '-e',
      'HOME=/tmp',
      ...opts.mounts.flatMap((m) => ['-v', `${m.host}:${m.container}${m.readonly ? ':ro' : ''}`]),
      ...buildProviderEnvArgs(this.provider, this.apiKey, this.apiBase, this.model),
      ...(opts.workdir ? ['-w', opts.workdir] : []),
      image,
      'sh',
      '/workspace/run-docker.sh',
    ];

    // Log command (redact any *_API_KEY value)
    const logArgs = args.map((a) => a.replace(/(_API_KEY=).+/, '$1***'));
    LogSink.debug(`Docker: docker ${logArgs.join(' ')}`, TraceTags.PI);

    const timeout = opts.timeout ?? this.timeoutMs + DOCKER_INSTALL_BUFFER_MS;

    // spawnSync (not execFileSync) so docker's stderr is captured on success too:
    // it is the only place daemon-level warnings show up, and the previous error
    // log printed "(empty)" for it whether or not anything had been written.
    // With the in-container redirect, docker's stdout is normally empty.
    const spawned = spawnSync('docker', args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf-8' });
    const dockerStdout = spawned.stdout ?? '';
    const dockerStderr = spawned.stderr ?? '';
    if (spawned.error || spawned.status !== 0) {
      const killed = Boolean(spawned.error) && spawned.signal !== null;
      appendDockerErrorLog({
        context: `docker run failed (model=${this.model}, provider=${this.provider}, image=${image})`,
        command: `docker ${logArgs.join(' ')}`,
        exitStatus: spawned.status,
        signal: spawned.signal,
        stdout: dockerStdout,
        stderr: dockerStderr,
        detail: killed
          ? `process killed (timeout ${timeout}ms or signal)`
          : String(spawned.error?.message ?? `docker exited with status ${spawned.status}`),
      });
      throw (
        spawned.error ??
        new Error(
          `docker run exited with status ${spawned.status}: ${dockerStderr.trim().slice(0, 300) || '(no stderr)'}`,
        )
      );
    }

    // The container writes the redirect file onto a bind mount; under some Docker
    // backends (notably WSL2) the host view can lag a beat behind container exit.
    // Retry the read briefly before treating a missing file as a real failure.
    const READ_ATTEMPTS = 4;
    let output: string | null = null;
    let readErr: NodeJS.ErrnoException | null = null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      try {
        output = readPiOutput(outHost);
        break;
      } catch (err) {
        readErr = err as NodeJS.ErrnoException;
        sleepSync(250);
      }
    }

    if (output === null) {
      // Never claim the file was "not produced" — the read can also fail because
      // the workspace was deleted mid-run or the log outgrew V8's string cap.
      const cause = describeOutputReadFailure(readErr, workspaceHost, outHost);
      appendDockerErrorLog({
        context: `docker exited cleanly but ${outLogName} could not be read (model=${this.model}, provider=${this.provider}, image=${image})`,
        command: `docker ${logArgs.join(' ')}`,
        exitStatus: spawned.status,
        signal: spawned.signal,
        stdout: dockerStdout,
        stderr: dockerStderr,
        detail: `after ${READ_ATTEMPTS} read attempts: ${cause}`,
      });
      throw new Error(`pi output unreadable after a clean docker exit: ${cause}; see data/error.log`);
    }

    // Dump last pi output to data/ for debugging (best-effort)
    try {
      const dumpDir = path.join(process.cwd(), 'data', 'pi-dumps');
      if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(dumpDir, `${ts}.jsonl`), output);
      // Keep only the last 10 dumps
      const files = fs.readdirSync(dumpDir).sort();
      for (const old of files.slice(0, -10)) {
        try {
          fs.unlinkSync(path.join(dumpDir, old));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore dump failure */
    }

    return output;
  }
}
