import { OpenAIProvider } from './openai.ts';

/**
 * Accept either a complete OpenAI API root (`.../v1`) or the root exposed by
 * a gateway (`.../api`). The latter is common in hosted compatible services.
 */
export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  if (/\/v\d+\/(?:chat\/completions|models)$/i.test(trimmed)) {
    return trimmed.replace(/\/(?:chat\/completions|models)$/i, '');
  }
  return `${trimmed}/v1`;
}

/**
 * Every root this provider is willing to try, best guess first.
 *
 * A gateway can live at the URL the user typed, under the `/v1` suffix we add
 * for them, or behind an `/api/v1` prefix. Probing in order means a server
 * that serves `/chat/completions` straight off the configured root still
 * works after normalization appended `/v1` to it.
 */
export function openAICompatibleRouteCandidates(baseUrl: string): string[] {
  const configured = baseUrl.trim().replace(/\/+$/, '');
  const candidates = [normalizeOpenAICompatibleBaseUrl(baseUrl)];

  try {
    const url = new URL(candidates[0]!);

    // Keep the root the user actually typed as a fallback, but only when they
    // typed a path with it. A bare origin is unambiguous — every compatible
    // server mounts its API under a version prefix — whereas `/openai` or
    // `/inference` may already BE the API root that normalization just
    // appended `/v1` to, which would otherwise 404 with no way back.
    const configuredPath = new URL(configured).pathname.replace(/\/+$/, '');
    if (configuredPath && configured !== candidates[0] && !candidates.includes(configured)) {
      candidates.push(configured);
    }

    if (url.pathname.replace(/\/+$/, '') === '/v1') {
      url.pathname = '/api/v1';
      const prefixed = url.toString().replace(/\/+$/, '');
      if (!candidates.includes(prefixed)) candidates.push(prefixed);
    }
  } catch {
    // A malformed URL simply has no alternate variants to offer.
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
   * An HTML body on a 403/404 means we hit the gateway's web UI rather than
   * its API — a routing miss worth retrying elsewhere. A JSON 403 is a real
   * authentication answer and must surface untouched.
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
    const ordered = [this.baseUrl, ...this.routes.filter((r) => r !== this.baseUrl)];
    let first: Response | undefined;

    for (const route of ordered) {
      const response = await attempt(route);
      if (!await this.isHtmlRouteFailure(response)) {
        this.baseUrl = route;
        return response;
      }
      first ??= response;
    }

    // Nothing routed. Reset to the best guess so the next call starts clean
    // and the caller sees the error from the root we most expected to work.
    this.baseUrl = this.routes[0]!;
    return first!;
  }

  protected override async postChat(body: Record<string, unknown>): Promise<Response> {
    return this.overRoutes(async (base) => {
      const previous = this.baseUrl;
      this.baseUrl = base;
      try {
        return await super.postChat(body);
      } finally {
        this.baseUrl = previous;
      }
    });
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
