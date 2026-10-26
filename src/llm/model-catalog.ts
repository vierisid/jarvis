/** Curated chat/tool models, verified 2026-10-21. Live account catalogs take precedence.
 * https://platform.claude.com/docs/en/models/overview
 * https://developers.openai.com/api/docs/models
 * https://ai.google.dev/gemini-api/docs/models
 * https://console.groq.com/docs/models
 * https://openrouter.ai/api/v1/models
 * https://ollama.com/library/qwen3.5
 * Keep onboarding, Settings and provider fallbacks on this one source.
 */
export const CHAT_MODEL_SUGGESTIONS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  openai: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
  gemini: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  groq: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
  ollama: ['qwen3.5:9b', 'qwen3:8b', 'gpt-oss:20b'],
  openrouter: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-4-argon'],
};
