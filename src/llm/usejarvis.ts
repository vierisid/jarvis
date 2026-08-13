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

  /** The key-scoped catalog: the uj-* aliases this plan includes.
   *
   * The proxy filters per key, but that is REMOTE state, not an invariant we
   * hold: a key minted with an empty `models` list and no team means the full
   * catalog at LiteLLM, not an empty one. Filtering to `uj-` locally keeps a
   * mis-scoped key from leaking raw upstream deployment ids into the tier
   * pickers — which would break alias opacity and let a user select a model
   * whose per-plan resale price was never configured. */
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
        .filter((id): id is string => typeof id === 'string' && id.startsWith('uj-')),
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

  /** Map proxy errors to actionable copy. The `(status)` marker is kept so
   * classifyErrorString still steers retries (429/503 retry; 400s do not).
   *
   * Branch ORDER matters: LiteLLM denies an out-of-plan model with a 401
   * "not allowed to access model", so the model check MUST run before the
   * generic auth branch — otherwise a paying user who picks a model outside
   * their plan is told their subscription is inactive, the worst false
   * message this feature can produce.
   *
   * The proxy's own body never rides along in the returned copy: it is not a
   * log-only channel — this Error's message becomes the chat bubble — and an
   * upstream body carries the hosted hostname that the settings surface and
   * the catalog route both deliberately withhold. Operators get it via
   * console.warn instead. */
  private friendly(status: number, detail: string): Error {
    // Redact FIRST: proxy auth bodies can echo the bearer we presented, and
    // this per-account key is deliberately hidden from every other surface
    // (settings, catalog route, provider test).
    const safe = redactSecrets(detail);
    const lower = safe.toLowerCase();
    if (safe) console.warn(`[usejarvis] proxy error (${status}): ${safe.slice(0, 200)}`);
    if (lower.includes('budget') && (lower.includes('exceed') || lower.includes('over'))) {
      return new Error(
        `${this.errorLabel} API error (${status}): your included AI usage is used up ` +
          `${describeBudgetWindow(safe)}. It resumes automatically - the usage meter shows when.`,
      );
    }
    if (lower.includes('model') && (lower.includes('not allowed') || lower.includes('invalid model'))) {
      return new Error(
        `${this.errorLabel} API error (${status}): that model is not included in your plan.`,
      );
    }
    if (status === 401 || status === 403) {
      return new Error(
        `${this.errorLabel} API error (${status}): Usejarvis AI is not active on this account - ` +
          'an active plan is required.',
      );
    }
    // Truncated: an unbounded body is how a CDN error page (hostname
    // included) reaches a chat bubble.
    return new Error(`${this.errorLabel} API error (${status})${safe ? `: ${safe.slice(0, 120)}` : ''}`);
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

/**
 * Turn a proxy budget body into the window phrase the friendly copy promises.
 * LiteLLM reports `budget_duration` and `budget_reset_at` on an exhausted
 * key, and the reset lands on a FIXED clock boundary (a 6h window minted
 * mid-morning resets at 12:00:00+00:00), so "resumes at 12:00 UTC" is exact
 * rather than approximate. Degrades to the generic phrase when the proxy
 * omits the fields — never guesses a time it was not told.
 *
 * Only the duration and timestamp are lifted out; the rest of the body stays
 * out of user-facing copy (it can carry the hosted hostname).
 */
function describeBudgetWindow(body: string): string {
  const duration = body.match(/budget_duration["'\s:=]+([0-9]+[a-z]+)/i)?.[1];
  const resetAt = body.match(/budget_reset_at["'\s:=]+([0-9T:.+\-]{10,40})/i)?.[1];
  const window = duration ? `for this ${duration} window` : 'for this window';
  if (!resetAt) return window;
  const parsed = new Date(resetAt);
  if (Number.isNaN(parsed.getTime())) return window;
  const hh = String(parsed.getUTCHours()).padStart(2, '0');
  const mm = String(parsed.getUTCMinutes()).padStart(2, '0');
  return `${window} (resumes ${hh}:${mm} UTC)`;
}
