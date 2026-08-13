import { OpenAIProvider } from './openai.ts';
import { redactSecrets } from '../util/redact.ts';

/**
 * Hosted "Usejarvis AI" provider: the platform's OpenAI-compatible LLM proxy.
 * Configured EXCLUSIVELY by the system-owned `usejarvis_ai` config.yaml block
 * (daemon/usejarvis-ai.ts injects it over every DB merge) — never by the
 * dashboard, which shows it read-only.
 *
 * The proxy exposes stable per-plan aliases (uj-chat / uj-low / uj-medium /
 * uj-high, plus voice slots) whose resolution happens server-side, so this
 * class stays plan-agnostic: `listModels()` returns exactly what this
 * account's key may call, and errors are rewritten into messages a user can
 * act on (limits, plan state) while preserving the `(status)` marker the
 * retry classifier keys on.
 */
export class UsejarvisAIProvider extends OpenAIProvider {
  override name = 'usejarvis_ai';

  constructor(baseUrl: string, apiKey: string) {
    // The provisioner writes the proxy ORIGIN (https://llm.example.host);
    // OpenAIProvider expects the /v1 prefix to already be present.
    const trimmed = baseUrl.replace(/\/+$/, '');
    super(apiKey, '', /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`);
  }

  protected override get errorLabel(): string {
    return 'Usejarvis AI';
  }

  /** The key-scoped catalog: the uj-* aliases this plan includes (the proxy
   * filters per key, so tier pickers need no hardcoded list). */
  override async listModels(): Promise<string[]> {
    const response = await fetch(this.modelsUrl, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      throw this.friendly(response.status, await response.text().catch(() => ''));
    }
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(payload.data)) {
      throw new Error(`${this.errorLabel} returned an invalid model catalog`);
    }
    return [...new Set(
      payload.data
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )].sort();
  }

  override async chat(
    ...args: Parameters<OpenAIProvider['chat']>
  ): ReturnType<OpenAIProvider['chat']> {
    try {
      return await super.chat(...args);
    } catch (error) {
      throw this.rewrite(error);
    }
  }

  override async *stream(
    ...args: Parameters<OpenAIProvider['stream']>
  ): ReturnType<OpenAIProvider['stream']> {
    try {
      yield* super.stream(...args);
    } catch (error) {
      throw this.rewrite(error);
    }
  }

  /** Map proxy errors to actionable copy. The `(status)` marker is kept so
   * classifyErrorString still steers retries (429/503 retry; 400s do not). */
  private friendly(status: number, detail: string): Error {
    // Redact FIRST: proxy auth bodies can echo the bearer we presented, and
    // this per-account key is deliberately hidden from every other surface
    // (settings, catalog route, provider test). It also keeps a key whose
    // random body happens to contain "429"/"503" from making a non-retryable
    // error retry — shouldRetry substring-matches those.
    const safe = redactSecrets(detail);
    const lower = safe.toLowerCase();
    if (lower.includes('budget') && (lower.includes('exceed') || lower.includes('over'))) {
      return new Error(
        `${this.errorLabel} API error (${status}): your included AI usage is used up for this window. ` +
          'It resumes automatically - the usage meter shows when.',
      );
    }
    if (status === 401 || status === 403 || lower.includes('blocked')) {
      return new Error(
        `${this.errorLabel} API error (${status}): Usejarvis AI is not active on this account - ` +
          'an active plan is required.',
      );
    }
    if (lower.includes('model') && (lower.includes('not allowed') || lower.includes('invalid model'))) {
      return new Error(
        `${this.errorLabel} API error (${status}): that model is not included in your plan.`,
      );
    }
    // Truncated: an unbounded body is how a CDN error page (hostname
    // included) reaches a chat bubble.
    return new Error(`${this.errorLabel} API error (${status})${safe ? `: ${safe.slice(0, 120)}` : ''}`);
  }

  private rewrite(error: unknown): unknown {
    if (!(error instanceof Error)) return error;
    // Base-class errors read "<label> API error (NNN): <body>" - re-map the
    // ones users can act on; pass everything else (network, aborts) through.
    const match = error.message.match(/API error \((\d+)\): ?([\s\S]*)$/);
    if (!match) return error;
    return this.friendly(Number(match[1]), match[2] ?? '');
  }
}
