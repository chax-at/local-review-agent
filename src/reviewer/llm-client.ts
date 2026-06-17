import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';

export interface ILlmConfig {
  name: string;
  apiKey: string;
  apiBase: string;
  model: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  authHeader?: string; // "api-key" for Azure, default Bearer
  /** Whether this model supports structured output (json_schema / json_object). Default true. */
  supportsStructuredOutput?: boolean;
  /** Which token-limit param to send: 'max_completion_tokens' (OpenAI) or 'max_tokens' (Azure/older). Default 'max_completion_tokens'. */
  maxTokenParam?: 'max_completion_tokens' | 'max_tokens';
  /** Extra body fields merged into every request (e.g. { max_completion_tokens: 4096 }) */
  extraBody?: Record<string, unknown>;
}

export interface ILlmResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/** JSON schema to send with structured output requests */
export interface IJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export function parseLlmResponse(raw: any): ILlmResponse {
  const content = raw?.choices?.[0]?.message?.content ?? '';
  const inputTokens = raw?.usage?.prompt_tokens ?? 0;
  const outputTokens = raw?.usage?.completion_tokens ?? 0;
  return { content, inputTokens, outputTokens };
}

/** Unwrap nested Error.cause chain into a readable string */
function unwrapErrorCause(err: unknown, depth = 0): string {
  if (depth > 5) return '...';
  if (err instanceof Error) {
    const { cause } = err as any;
    // Some Node errors have empty message but meaningful code/syscall
    const errAny = err as any;
    const extras = [errAny.code, errAny.syscall, errAny.hostname, errAny.errno].filter(Boolean).join(' ');
    const msg = err.message || extras || err.constructor.name;
    const parts = [msg];
    if (cause) parts.push(`  cause: ${unwrapErrorCause(cause, depth + 1)}`);
    return parts.join('\n');
  }
  return String(err);
}

/** Classify HTTP status into a human-readable category */
function classifyHttpStatus(status: number): string {
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'REQUEST_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'CLIENT_ERROR';
}

export class LlmClient {
  constructor(private readonly config: ILlmConfig) {}

  public get name(): string {
    return this.config.name;
  }
  public get inputCostPer1M(): number {
    return this.config.inputCostPer1M;
  }
  public get outputCostPer1M(): number {
    return this.config.outputCostPer1M;
  }

  public async chat(
    systemPrompt: string,
    userMessage: string,
    opts?: { jsonMode?: boolean; jsonSchema?: IJsonSchema },
  ): Promise<ILlmResponse> {
    const url = this.chatUrl();
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      ...this.config.extraBody,
    };

    // Structured output: only when model supports it (inspired by storywise endpoint flags)
    if (opts?.jsonMode && this.supportsStructuredOutput()) {
      if (opts.jsonSchema) {
        // Full json_schema mode — most reliable for parsing
        body.response_format = {
          type: 'json_schema',
          json_schema: { ...opts.jsonSchema, strict: true },
        };
      } else {
        body.response_format = { type: 'json_object' };
      }
    }

    LogSink.debug(`LLM ${this.config.name}: calling ${this.config.model} at ${url}`, TraceTags.PI);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const text = await response.text();
        const category = classifyHttpStatus(response.status);
        throw new Error(`LLM ${this.config.name} [${category}]: ${response.status} ${text.slice(0, 300)}`);
      }

      const raw = await response.json();
      return parseLlmResponse(raw);
    } catch (err) {
      if (err instanceof TypeError) {
        // fetch() throws TypeError for network-level failures (DNS, TLS, connection refused)
        throw new Error(`LLM ${this.config.name} network error: ${unwrapErrorCause(err)}`);
      }
      throw err;
    }
  }

  public async ping(): Promise<void> {
    const url = this.chatUrl();
    LogSink.debug(`Ping ${this.config.name}: ${url} (model=${this.config.model})`, TraceTags.PI);

    const tokenParam = this.config.maxTokenParam ?? 'max_completion_tokens';
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [{ role: 'user', content: 'Reply with: ok' }],
      [tokenParam]: 5,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (response.ok) {
        await response.json();
        return;
      }

      const text = await response.text();
      const category = classifyHttpStatus(response.status);
      throw new Error(`Ping ${this.config.name} [${category}]: ${response.status} ${text.slice(0, 300)}`);
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error(`Ping ${this.config.name} network error: ${unwrapErrorCause(err)}`);
      }
      throw err;
    }
  }

  private chatUrl(): string {
    return `${this.config.apiBase.replace(/\/$/, '')}/chat/completions`;
  }

  private supportsStructuredOutput(): boolean {
    return this.config.supportsStructuredOutput !== false;
  }

  private authHeaders(): Record<string, string> {
    return this.config.authHeader === 'api-key'
      ? { 'api-key': this.config.apiKey }
      : { Authorization: `Bearer ${this.config.apiKey}` };
  }
}
