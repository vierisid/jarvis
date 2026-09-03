import { OpenAIProvider, type OpenAIMessage } from './openai.ts';
import type { LLMMessage } from './provider.ts';
import { hostedProxyError, isBudgetExhaustion } from '../util/hosted-error.ts';
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

  private readonly promptCache: boolean;

  constructor(baseUrl: string, apiKey: string, opts?: { promptCache?: boolean }) {
    // The provisioner writes the proxy ORIGIN (https://llm.example.host);
    // OpenAIProvider expects the /v1 prefix to already be present.
    const trimmed = baseUrl.replace(/\/+$/, '');
    // uj-medium as the default model: the manager's failover path retries a
    // provider WITHOUT a model assignment (chatTier deletes options.model),
    // and an empty default posted `{"model":""}` — a guaranteed 400 that
    // replaced the original error. Every plan carries the mid alias.
    super(apiKey, 'uj-medium', /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`);
    // OPT-IN, defaulting OFF — the inverse of the sibling providers. The
    // uj-* aliases are vendor-opaque by design, so this client cannot know
    // whether a marker lands on an Anthropic upstream (harmless, saves
    // margin) or a non-Anthropic one (rejected as an unknown property →
    // every call 400s). Only the provisioner can assert proxy behavior;
    // see the `usejarvis_ai.prompt_cache` block comment in config/types.ts
    // for the three conditions to confirm before enabling.
    this.promptCache = opts?.promptCache === true;
  }

  /** The proxy (LiteLLM) supports stream_options.include_usage; without it
   * streamed turns record zero usage and a silent cache decline is
   * indistinguishable from success on the primary conversational path. */
  protected override get streamIncludeUsage(): boolean {
    return true;
  }

  /** Every hosted chat alias (uj-chat / uj-low / uj-medium / uj-high) resolves
   * to a premium REASONING model (gpt-5.6-*, claude-opus-*) that accepts only
   * the default temperature (1). The aliases are vendor-opaque by design, so the
   * base class's by-name check can never see it — the brain must assume the
   * strictest rule and never send a custom temperature. Confirmed live: `uj-high`
   * + temperature 0.4 → 400 "claude-opus-5 does not support temperature=0.4;
   * only temperature=1 is supported". If a future plan adds a non-reasoning
   * alias, this becomes model-aware; today omitting it is always correct. */
  protected override rejectsCustomTemperature(_model: string): boolean {
    return true;
  }

  /**
   * Attach Anthropic prompt-cache breakpoints, in OpenAI wire format.
   *
   * MARGIN-CRITICAL. Agentic turns re-send a growing prefix, and a cached
   * read bills at a fraction of fresh input — measured 0.1027x against the
   * platform's own resale price. Without markers every hosted turn pays
   * full rate on text the upstream has already seen.
   *
   * Why per-content-part and not a top-level field: OpenRouter accepts a
   * top-level `cache_control`, LiteLLM does not — it forwards the marker
   * only when it rides ON a content part. Verified live against the proxy
   * (see "Usejarvis AI prompt caching" in docs/LLM_PROVIDERS.md for the
   * record and its limits): a marked system part and a marked user part
   * both reached Anthropic intact and billed the second call at the cache
   * rate. That is ALL the live verification covers — which is why emission
   * is gated on the provisioner's `prompt_cache` opt-in (see constructor).
   *
   * Two breakpoints, matching AnthropicProvider exactly (see
   * `applyLastMessageBreakpoint` and the system-block reduce there — the two
   * providers implement ONE policy and must not drift):
   *
   *   - the last system message marked `cache: true`. NOT simply the last
   *     system message: callers emit `[static (cache:true), profile
   *     (cache:true), dynamic (unmarked)]`, and the dynamic block carries
   *     elapsed-second counters and recent results. A breakpoint there would
   *     end the cached prefix on bytes that change every turn, so the entry
   *     could never be read back — paying the write premium for nothing and
   *     re-billing the whole persona at full rate. `cache` is the codebase's
   *     declared boundary (see LLMMessage) and is what to honour.
   *
   *   - the last USER message, a rolling breakpoint so each request writes
   *     the prefix the next one reads — but ONLY on conversational requests.
   *     One-shot calls (classification, extraction, a periodic screen
   *     capture) never resend their prefix, so a breakpoint there is a
   *     guaranteed-unread 1.25x cache write. Presence of an assistant turn is
   *     the same signal AnthropicProvider uses.
   *
   *     The last USER message, not the last message overall: from the second
   *     agentic iteration onward the last message is a `tool` result, and
   *     LiteLLM's tool→tool_result translation is NOT verified to carry a
   *     content-part cache_control through (the live POC covered system and
   *     user parts only — see docs/LLM_PROVIDERS.md). A marker there is
   *     either silently dropped (no-op on exactly the loop this feature
   *     exists for) or rejected by the proxy. The user message is the newest
   *     anchor with a verified translation.
   *
   * Both boundary picks skip messages with no text content: promoting an
   * empty block would either bail (suppressing the breakpoint entirely) or
   * produce a part with no text, where AnthropicProvider falls back to the
   * previous marked block — the two providers must not drift.
   *
   * Anthropic allows 4 breakpoints; staying at 2 leaves room.
   */
  protected override convertMessages(messages: LLMMessage[]): OpenAIMessage[] {
    const converted = super.convertMessages(messages);
    if (!this.promptCache || converted.length === 0) return converted;

    // super.convertMessages is a 1:1 map, so indices align with `messages`
    // and the `cache` flag can be read off the originals.
    const marks = new Set<number>();
    const lastMarkedSystem = messages.reduce(
      (found, m, i) => (m.role === 'system' && m.cache === true && hasTextContent(m) ? i : found),
      -1,
    );
    if (lastMarkedSystem >= 0) {
      marks.add(lastMarkedSystem);
    } else {
      // No declared boundary: fall back to the last system message, which is
      // then the whole system prefix and is as stable as the caller made it.
      const lastSystem = messages.reduce(
        (found, m, i) => (m.role === 'system' && hasTextContent(m) ? i : found),
        -1,
      );
      if (lastSystem >= 0) marks.add(lastSystem);
    }
    if (messages.some((m) => m.role === 'assistant')) {
      const lastUser = messages.reduce(
        (found, m, i) => (m.role === 'user' && hasTextContent(m) ? i : found),
        -1,
      );
      if (lastUser >= 0) marks.add(lastUser);
    }
    if (marks.size === 0) return converted;

    return converted.map((msg, i) => (marks.has(i) ? markCacheBreakpoint(msg) : msg));
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
    return (await this.listModelsDetailed()).models;
  }

  /** Like listModels, but reports whether the result is the live plan catalog
   * or the degraded fallback — the catalog route forwards the flag so the
   * dashboard can offer a retry instead of presenting the fallback as truth.
   * Never throws: the LLMProvider contract is degrade-to-fallback (every
   * sibling catches), and the first caller — the tier-picker catalog route —
   * must not turn a transient proxy 503 into an unhandled rejection. The
   * fallback is the four core aliases every plan carries. */
  async listModelsDetailed(): Promise<{ models: string[]; degraded: boolean }> {
    const fallback = { models: UsejarvisAIProvider.FALLBACK_MODELS.slice(), degraded: true };
    try {
      const response = await fetch(this.modelsUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        console.warn(`[usejarvis] model catalog unavailable (${response.status}); serving fallback aliases`);
        return fallback;
      }
      const payload = await response.json() as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(payload.data)) {
        console.warn(`[usejarvis] model catalog malformed; serving fallback aliases`);
        return fallback;
      }
      const models = [...new Set(
        payload.data
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === 'string' && id.startsWith('uj-')),
      )].sort();
      return { models, degraded: false };
    } catch (err) {
      console.warn('[usejarvis] model catalog fetch failed; serving fallback aliases:', err instanceof Error ? err.message : err);
      return fallback;
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
      throw await this.rewrite(error);
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
        yield { ...event, error: await this.rewriteText(event.error) };
      } else {
        yield event;
      }
    }
  }

  /** Memoized `/key/info` result — success AND failure both count, so an
   * exhausted-budget burst issues at most one lookup per window. */
  private resetCache: { at: number; value: Date | null } | null = null;
  private static readonly RESET_CACHE_MS = 60_000;

  /** Reset-time lookup for the budget-exhaustion copy.
   *
   * The 429 budget body carries NO timestamp (confirmed by the platform team);
   * the reset time lives on `GET /key/info` at the proxy ROOT (not under /v1),
   * readable with this same account key, as ISO-8601 with an explicit offset
   * (e.g. "2026-08-19T12:00:00+00:00" under `info.budget_reset_at`).
   *
   * Only the parsed Date ever leaves this method: the /key/info body follows
   * the same discipline as every other proxy body and never reaches user copy.
   * Any failure — timeout, non-200, missing field, unparseable date — degrades
   * to a time-less budget message (never guess a time you were not told). */
  private async budgetResetAt(): Promise<Date | null> {
    const now = Date.now();
    if (this.resetCache && now - this.resetCache.at < UsejarvisAIProvider.RESET_CACHE_MS) {
      return this.resetCache.value;
    }
    let value: Date | null = null;
    try {
      const root = this.baseUrl.replace(/\/v1$/, '');
      const response = await fetch(`${root}/key/info`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const payload = await response.json() as {
          info?: { budget_reset_at?: unknown };
          budget_reset_at?: unknown;
        };
        const raw = payload.info?.budget_reset_at ?? payload.budget_reset_at;
        if (typeof raw === 'string') {
          const parsed = new Date(raw);
          if (!Number.isNaN(parsed.getTime())) value = parsed;
        }
        if (!value) console.warn('[usejarvis] /key/info carried no parseable budget_reset_at; budget copy stays time-less');
      } else {
        console.warn(`[usejarvis] /key/info unavailable (${response.status}); budget copy stays time-less`);
      }
    } catch (err) {
      console.warn(
        '[usejarvis] /key/info lookup failed; budget copy stays time-less:',
        redactSecrets(err instanceof Error ? err.message : String(err)),
      );
    }
    this.resetCache = { at: now, value };
    return value;
  }

  /** Shared with the hosted STT/TTS providers — see util/hosted-error.ts for
   * the redaction, branch-order and no-body-in-copy rules. The "<label> API"
   * form keeps the exact `Usejarvis AI API error (NNN)` prefix that
   * classifyErrorString and rewriteText both parse. Budget errors trigger the
   * /key/info reset lookup so the copy can quote a real resume time. */
  private async friendly(status: number, detail: string): Promise<Error> {
    const resetAt = isBudgetExhaustion(detail) ? await this.budgetResetAt() : null;
    return hostedProxyError(`${this.errorLabel} API`, status, detail, resetAt);
  }

  /** Text-shaped variant of `rewrite` for stream error EVENTS (the base class
   * yields these rather than throwing — see `stream`). */
  /** Base-class errors come in two shapes: the legacy "<label> API error
   * (NNN): <body>" and the current "<label> API error: HTTP NNN: <body>"
   * (formatOpenAIHttpError). Accept both so a base-class format change can
   * never silently disable the hosted rewrites again. */
  private static readonly BASE_ERROR_RE =
    /API error(?: \((\d+)\):|: HTTP (\d+):?) ?([\s\S]*)$/;

  private async rewriteText(text: string): Promise<string> {
    const match = text.match(UsejarvisAIProvider.BASE_ERROR_RE);
    if (!match) return text;
    return (await this.friendly(Number(match[1] ?? match[2]), match[3] ?? '')).message;
  }

  private async rewrite(error: unknown): Promise<unknown> {
    if (!(error instanceof Error)) return error;
    // Re-map the errors users can act on; pass everything else (network,
    // aborts) through untouched.
    const match = error.message.match(UsejarvisAIProvider.BASE_ERROR_RE);
    if (!match) return error;
    return this.friendly(Number(match[1] ?? match[2]), match[3] ?? '');
  }
}


/** True when the message carries at least one non-empty text span — the only
 * shape markCacheBreakpoint can attach a marker to. Boundary selection skips
 * anything else so an empty marked block cannot suppress the breakpoint
 * (AnthropicProvider filters empty blocks the same way). */
function hasTextContent(m: LLMMessage): boolean {
  if (typeof m.content === 'string') return m.content.length > 0;
  return m.content.some(
    (b) => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string'
      && (b as { text: string }).text.length > 0,
  );
}

/**
 * Put an `ephemeral` cache breakpoint on a message's LAST TEXT part,
 * promoting plain-string content to a single text part (the marker cannot
 * ride on a bare string).
 *
 * Left untouched when there is nothing safe to mark:
 *  - assistant messages carrying tool_calls, whose content must stay '' —
 *    promoting it to a part array changes the semantics the API expects;
 *  - empty content, which would produce a part with no text;
 *  - a part array with no text part at all (image-only).
 * An image part itself is never marked — the breakpoint goes on the last
 * TEXT part, so a trailing image simply falls outside the cached prefix
 * while the message's interior text part still carries the marker.
 */
function markCacheBreakpoint(msg: OpenAIMessage): OpenAIMessage {
  if (msg.tool_calls && msg.tool_calls.length > 0) return msg;

  if (typeof msg.content === 'string') {
    if (!msg.content) return msg;
    return {
      ...msg,
      content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }],
    };
  }

  const parts = msg.content;
  const lastText = parts.reduce((found, p, i) => (p.type === 'text' ? i : found), -1);
  if (lastText < 0) return msg;
  return {
    ...msg,
    content: parts.map((p, i) =>
      i === lastText ? { ...p, cache_control: { type: 'ephemeral' as const } } : p,
    ),
  };
}
