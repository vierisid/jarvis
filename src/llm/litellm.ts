import { OpenAIProvider } from './openai.ts';

/**
 * LiteLLM provider. LiteLLM is an OpenAI-compatible proxy/gateway that
 * routes requests to 100+ underlying LLM providers (OpenAI, Anthropic,
 * Bedrock, Vertex, Azure, Ollama, etc.) behind a single endpoint.
 *
 * Speaks the OpenAI `/chat/completions` schema, so we extend
 * `OpenAIProvider` and only override the identity and defaults.
 *
 * Defaults assume a self-hosted proxy at `http://localhost:4000/v1`.
 * `OpenAIProvider` only appends `/chat/completions` to the `base_url`,
 * so the URL stored here must already include whatever path prefix the
 * proxy expects (typically `/v1`). Auth uses a LiteLLM "virtual key"
 * passed as a Bearer token; for unauthenticated local proxies the key
 * may be left blank.
 *
 * Docs: https://docs.litellm.ai/docs/
 */
export class LiteLLMProvider extends OpenAIProvider {
  override name = 'litellm';

  constructor(baseUrl = 'http://localhost:4000/v1', defaultModel = '', apiKey = '') {
    super(apiKey, defaultModel, baseUrl);
  }

  protected override get errorLabel(): string {
    return 'LiteLLM';
  }
}
