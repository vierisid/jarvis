/**
 * Retired Groq chat models and the supported defaults that replace them.
 * Replacements are capability-matched (70b-class -> gpt-oss-120b, small ->
 * gpt-oss-20b); the provider-wide default stays gpt-oss-20b (cheap tier).
 */
export const GROQ_DEPRECATED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
  'deepseek-r1-distill-llama-70b': 'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
  'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
  'qwen/qwen3-32b': 'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct': 'openai/gpt-oss-20b',
  'meta-llama/llama-4-maverick-17b-128e-instruct': 'openai/gpt-oss-120b',
};

export function isDeprecatedGroqModel(id: string): boolean {
  return Object.hasOwn(GROQ_DEPRECATED_MODEL_REPLACEMENTS, id);
}
