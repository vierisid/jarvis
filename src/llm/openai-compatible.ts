import { OpenAIProvider } from './openai.ts';

/** Endpoint paths users commonly paste in place of the API root. */
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|models)$/i;

/**
 * Accept either a complete OpenAI API root (`.../v1`) or the root exposed by
 * a gateway (`.../api`). The latter is common in hosted compatible services.
 */
export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  if (/\/v\d+\/(?:chat\/completions|models)$/i.test(trimmed)) {
    return trimmed.replace(ENDPOINT_SUFFIX, '');
  }
  return `${trimmed}/v1`;
}

/**
 * Every root this provider is willing to try, best guess first.
 *
 * A gateway can live at the root the user typed, under the `/v1` suffix we
 * add for them, or behind an `/api/v1` prefix. Probing in order means a
 * server that serves `/chat/completions` straight off the configured root
 * still works after normalization appended `/v1` to it.
 */
export function openAICompatibleRouteCandidates(baseUrl: string): string[] {
  const normalized = normalizeOpenAICompatibleBaseUrl(baseUrl);
  const candidates = [normalized];

  // Keep the root the user typed as a fallback, but only when normalization's
  // sole change was appending `/v1` — `/openai` may already BE the API root.
  // Anything the normalizer rewrote (a pasted `/chat/completions` endpoint)
  // must NOT come back, or requests land on `.../chat/completions/chat/completions`.
  const stripped = baseUrl.trim().replace(/\/+$/, '').replace(ENDPOINT_SUFFIX, '');
  try {
    const hasPath = Boolean(new URL(stripped).pathname.replace(/\/+$/, ''));
    if (hasPath && normalized === `${stripped}/v1`) candidates.push(stripped);
  } catch {
    // Unparseable input has no fallback to offer.
  }

  // A gateway mounted behind `/api` is the other common shape.
  try {
    const url = new URL(normalized);
    if (url.pathname.replace(/\/+$/, '').toLowerCase() === '/v1') {
      url.pathname = '/api/v1';
      const prefixed = url.toString().replace(/\/+$/, '');
      if (!candidates.includes(prefixed)) candidates.push(prefixed);
    }
  } catch {
    // Likewise.
  }

  return candidates;
}

/**
 * Generic OpenAI-compatible provider. Reuses the full OpenAI implementation
 * but points at a user-supplied base URL — for llama.cpp, vLLM, LM Studio,
 * TGI, Together, Anyscale, and anything else that speaks
 * /v1/chat/completions. Distinct from the OpenAI provider in the UI so
 * users see a clear "this needs a base URL" flow.
 *
 * The API key is optional: local servers commonly leave auth off, but some
 * compatible cloud endpoints still require a bearer token.
 */
export class OpenAICompatibleProvider extends OpenAIProvider {
  override name = 'openai_compatible';

  /** Every root worth trying, in priority order. Never mutated. */
  private readonly routes: string[];

  constructor(baseUrl: string, defaultModel = '', apiKey = '', authHeader = 'Authorization') {
    super(apiKey, defaultModel, normalizeOpenAICompatibleBaseUrl(baseUrl), authHeader);
    this.routes = openAICompatibleRouteCandidates(baseUrl);
  }

  protected override get errorLabel(): string {
    return 'OpenAI-compatible';
  }

  /**
   * An HTML body on a 403/404 means we reached the gateway's web UI rather
   * than its API — a routing miss worth retrying elsewhere. A JSON 403 is a
   * real authentication answer and must surface untouched.
   */
  private async isHtmlRouteFailure(response: Response): Promise<boolean> {
    if (response.status !== 403 && response.status !== 404) return false;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/html')) return true;
    const body = await response.clone().text();
    return /^\s*(?:<!doctype html|<html)/i.test(body);
  }

  /**
   * Run `attempt` against each candidate root until one answers something
   * other than an HTML routing miss.
   *
   * The winning root is remembered so a working gateway costs one request per
   * call rather than re-probing every time — but it is only ever a cached
   * preference. If the remembered root later returns a routing miss (a
   * reverse-proxy change, a transient interstitial), the next call re-probes
   * from the top instead of staying pinned to a root that no longer works.
   */
  private async overRoutes(attempt: (base: string) => Promise<Response>): Promise<Response> {
    const preferred = this.baseUrl;
    const ordered = [preferred, ...this.routes.filter((r) => r !== preferred)];
    let firstMiss: Response | undefined;

    for (const route of ordered) {
      const response = await attempt(route);
      if (!await this.isHtmlRouteFailure(response)) {
        this.baseUrl = route;
        return response;
      }
      // Keep the first miss to report; drain the rest so their bodies aren't
      // left open.
      if (firstMiss) void response.body?.cancel();
      else firstMiss = response;
    }

    // Nothing routed. Reset to the best guess so the next call re-probes from
    // the top; the returned error is the one from `preferred`, the root we
    // had most reason to expect would work.
    this.baseUrl = this.routes[0]!;
    return firstMiss!;
  }

  protected override postChat(body: Record<string, unknown>, base?: string): Promise<Response> {
    if (base !== undefined) return super.postChat(body, base);
    return this.overRoutes((route) => super.postChat(body, route));
  }

  override async listModels(): Promise<string[]> {
    const response = await this.overRoutes((base) =>
      fetch(`${base}/models`, { headers: this.requestHeaders(false) }));

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible models API error: ${response.status}${body.trim() ? ` ${body.trim().slice(0, 300)}` : ''}`);
    }
    const data = await response.json() as { data?: Array<{ id?: string }> };
    return [...new Set((data.data ?? []).map(model => model.id).filter((id): id is string => Boolean(id)))];
  }
}
