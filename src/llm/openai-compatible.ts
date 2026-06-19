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

  /**
   * llama.cpp's server reuses the KV cache for a matching prompt prefix when
   * `cache_prompt` is set, so a stable system prompt is prefilled once instead
   * of re-evaluated every turn — the fix for the multi-second prompt-eval the
   * user saw on local models. Unknown to most other OpenAI-compatible servers,
   * which ignore unrecognized body fields, so it's safe to always send here
   * (and is NOT sent by the OpenAI provider proper, which rejects unknowns).
   */
  protected override extraBodyParams(): Record<string, unknown> {
    return { cache_prompt: true };
  }
}
