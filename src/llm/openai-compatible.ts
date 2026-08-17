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

  constructor(baseUrl: string, defaultModel = '', apiKey = '', authHeader = 'Authorization') {
    super(apiKey, defaultModel, normalizeOpenAICompatibleBaseUrl(baseUrl), authHeader);
  }

  protected override get errorLabel(): string {
    return 'OpenAI-compatible';
  }

  private apiPrefixedBaseUrl(): string | null {
    const url = new URL(this.baseUrl);
    if (url.pathname.replace(/\/+$/, '') !== '/v1') return null;
    url.pathname = '/api/v1';
    return url.toString().replace(/\/+$/, '');
  }

  private async isHtmlRouteFailure(response: Response): Promise<boolean> {
    if (response.status !== 403 && response.status !== 404) return false;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/html')) return true;
    const body = await response.clone().text();
    return /^\s*(?:<!doctype html|<html)/i.test(body);
  }

  protected override async postChat(body: Record<string, unknown>): Promise<Response> {
    const response = await super.postChat(body);
    const alternate = this.apiPrefixedBaseUrl();
    if (!alternate || !await this.isHtmlRouteFailure(response)) return response;
    this.baseUrl = alternate;
    return super.postChat(body);
  }

  override async listModels(): Promise<string[]> {
    let response = await fetch(this.modelsUrl, { headers: this.requestHeaders(false) });
    const alternate = this.apiPrefixedBaseUrl();
    if (alternate && await this.isHtmlRouteFailure(response)) {
      this.baseUrl = alternate;
      response = await fetch(this.modelsUrl, { headers: this.requestHeaders(false) });
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible models API error: ${response.status}${body.trim() ? ` ${body.trim().slice(0, 300)}` : ''}`);
    }
    const data = await response.json() as { data?: Array<{ id?: string }> };
    return [...new Set((data.data ?? []).map(model => model.id).filter((id): id is string => Boolean(id)))].sort();
  }
}
