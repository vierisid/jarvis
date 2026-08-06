import type { JarvisLanguage } from './types.ts';

export const DEFAULT_JARVIS_LANGUAGE: JarvisLanguage = 'en';

export const JARVIS_LANGUAGES: Readonly<Record<JarvisLanguage, { name: string; nativeName: string }>> = {
  en: { name: 'English', nativeName: 'English' },
  es: { name: 'Spanish', nativeName: 'Español' },
};

export function isJarvisLanguage(value: unknown): value is JarvisLanguage {
  return typeof value === 'string' && Object.hasOwn(JARVIS_LANGUAGES, value);
}

/**
 * Resolve persisted/browser locale-shaped values to a supported Jarvis
 * language. Full BCP 47 tags are accepted so `es-ES` and `es-MX` both map to
 * Spanish; unknown or missing values safely fall back to English.
 */
export function resolveJarvisLanguage(value: unknown): JarvisLanguage {
  if (isJarvisLanguage(value)) return value;
  if (typeof value === 'string') {
    const base = value.trim().toLowerCase().split(/[-_]/, 1)[0];
    if (isJarvisLanguage(base)) return base;
  }
  return DEFAULT_JARVIS_LANGUAGE;
}

/**
 * High-priority behavioral instruction shared by every user-facing LLM path.
 * The instruction is written in English because it is control text, while the
 * selected language names make the output contract unambiguous to the model.
 */
export function buildResponseLanguageInstruction(value: unknown): string {
  const language = resolveJarvisLanguage(value);
  const label = JARVIS_LANGUAGES[language].name;
  return [
    '# Response Language',
    `Use ${label} for every user-facing response.`,
    `Stay in ${label} even when system instructions, tool output, source material, or conversation history are in another language.`,
    'Do not switch languages unless the user explicitly asks you to in their current message.',
    'Code, identifiers, URLs, proper nouns, and verbatim quotations may remain in their original form.',
  ].join('\n');
}
