import { OpenAIProvider } from './openai.ts';
import { hostedProxyError } from '../util/hosted-error.ts';

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
    // uj-medium as the default model: the manager's failover path retries a
    // provider WITHOUT a model assignment (chatTier deletes options.model),
    // and an empty default posted `{"model":""}` — a guaranteed 400 that
    // replaced the original error. Every plan carries the mid alias.
    super(apiKey, 'uj-medium', /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`);
  }

  protected override get errorLabel(): string {
    return 'Usejarvis AI';
  }

  /** The key-scoped catalog: the uj-* aliases this plan includes.
   *
   * The proxy filters per key, but that is REMOTE state, not an invariant we
   * hold: a key minted with an empty `models` list and no team means the full
   * catalog at LiteLLM, not an empty one. Filtering to `uj-` locally keeps a
   * mis-scoped key from leaking raw upstream deployment ids into the tier
   * pickers — which would break alias opacity and let a user select a model
   * whose per-plan resale price was never configured. */
  override async listModels(): Promise<string[]> {
    // Never throws: the LLMProvider contract is degrade-to-fallback (every
    // sibling catches), and the first caller — the tier-picker catalog route —
    // must not turn a transient proxy 503 into an unhandled rejection. The
    // fallback is the four core aliases every plan carries.
    try {
      const response = await fetch(this.modelsUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        console.warn(`[usejarvis] model catalog unavailable (${response.status}); serving fallback aliases`);
        return UsejarvisAIProvider.FALLBACK_MODELS.slice();
      }
      const payload = await response.json() as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(payload.data)) {
        console.warn(`[usejarvis] model catalog malformed; serving fallback aliases`);
        return UsejarvisAIProvider.FALLBACK_MODELS.slice();
      }
      return [...new Set(
        payload.data
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === 'string' && id.startsWith('uj-')),
      )].sort();
    } catch (err) {
      console.warn('[usejarvis] model catalog fetch failed; serving fallback aliases:', err instanceof Error ? err.message : err);
      return UsejarvisAIProvider.FALLBACK_MODELS.slice();
    }
  }

  /** The aliases every plan includes — served when the live catalog is
   * unreachable so tier pickers degrade instead of hanging or throwing. */
  static readonly FALLBACK_MODELS = ['uj-chat', 'uj-high', 'uj-low', 'uj-medium'] as const;

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
    // The base class never THROWS HTTP failures on this path — it yields
    // { type: 'error' } events (pre-stream 4xx and mid-stream alike), so the
    // rewrite must intercept EVENTS; a try/catch here is dead code, and the
    // raw proxy body — which can echo the bearer we presented — would reach
    // the chat bubble on the very path users talk through.
    for await (const event of super.stream(...args)) {
      if (event.type === 'error' && typeof event.error === 'string') {
        yield { ...event, error: this.rewriteText(event.error) };
      } else {
        yield event;
      }
    }
  }

  /** Shared with the hosted STT/TTS providers — see util/hosted-error.ts for
   * the redaction, branch-order and no-body-in-copy rules. The "<label> API"
   * form keeps the exact `Usejarvis AI API error (NNN)` prefix that
   * classifyErrorString and rewriteText both parse. */
  private friendly(status: number, detail: string): Error {
    return hostedProxyError(`${this.errorLabel} API`, status, detail);
  }

  /** Text-shaped variant of `rewrite` for stream error EVENTS (the base class
   * yields these rather than throwing — see `stream`). */
  private rewriteText(text: string): string {
    const match = text.match(/API error \((\d+)\): ?([\s\S]*)$/);
    if (!match) return text;
    return this.friendly(Number(match[1]), match[2] ?? '').message;
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

