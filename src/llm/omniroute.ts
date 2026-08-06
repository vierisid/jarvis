import { OpenAIProvider } from './openai.ts';

/**
 * OmniRoute is an OpenAI-compatible gateway that combines provider models,
 * subscription-backed routes, free routes, and user-defined routing combos
 * behind one endpoint. Reusing OpenAIProvider gives it the same multimodal
 * messages, streaming, and function/tool-call support as Jarvis' OpenAI path.
 *
 * OmniRoute's default local API is http://localhost:20128/v1. A remote or
 * reverse-proxied installation can be supplied through baseUrl instead.
 */
export class OmniRouteProvider extends OpenAIProvider {
  override name = 'omniroute';

  constructor(
    baseUrl = 'http://localhost:20128/v1',
    defaultModel = 'auto',
    apiKey = '',
  ) {
    super(apiKey, defaultModel, baseUrl);
  }

  protected override get errorLabel(): string {
    return 'OmniRoute';
  }

  /**
   * Return the complete live catalog, including OmniRoute combos and routing
   * aliases. OpenAIProvider intentionally filters its catalog to OpenAI model
   * families, which is incorrect for a multi-provider gateway.
   */
  override async listModels(): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await fetch(this.modelsUrl, { headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `OmniRoute API error (${response.status}) while listing routes${detail ? `: ${detail}` : ''}`,
      );
    }

    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(payload.data)) {
      throw new Error('OmniRoute returned an invalid model catalog');
    }

    return [...new Set(
      payload.data
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )].sort((a, b) => a.localeCompare(b));
  }
}
