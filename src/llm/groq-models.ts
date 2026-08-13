/**
 * Retired Groq chat models and the supported defaults that replace them.
 * Replacements are capability-matched (70b-class -> gpt-oss-120b, small ->
 * gpt-oss-20b); the provider-wide default stays gpt-oss-20b (cheap tier).
 *
 * Scope: repairing saved "provider:model" references and keeping the offline
 * fallback suggestions current — the two places we have to guess because the
 * account cannot be asked. It must NOT filter a live /models response: those
 * are per-account, and a committed-spend contract keeps serving IDs that are
 * retired for everyone else.
 */
export const GROQ_DEPRECATED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
  'deepseek-r1-distill-llama-70b': 'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
  'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
  'qwen/qwen3-32b': 'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct': 'openai/gpt-oss-20b',
  'meta-llama/llama-4-maverick-17b-128e-instruct': 'openai/gpt-oss-120b',
};
