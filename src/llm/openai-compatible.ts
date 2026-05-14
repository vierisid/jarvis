import { OpenAIProvider } from './openai.ts';

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

  constructor(baseUrl: string, defaultModel = '', apiKey = '') {
    super(apiKey, defaultModel, baseUrl);
  }

  protected override get errorLabel(): string {
    return 'OpenAI-compatible';
  }
}
