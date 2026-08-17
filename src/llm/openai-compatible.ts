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

  override async listModels(): Promise<string[]> {
    const response = await fetch(this.modelsUrl, { headers: this.requestHeaders(false) });
    if (!response.ok) {
      throw new Error(`OpenAI-compatible models API error (${response.status})`);
    }
    const data = await response.json() as { data?: Array<{ id?: string }> };
    return [...new Set((data.data ?? []).map(model => model.id).filter((id): id is string => Boolean(id)))].sort();
  }
}
