import { describe, expect, test } from 'bun:test';
import {
  buildResponseLanguageInstruction,
  isJarvisLanguage,
  resolveJarvisLanguage,
} from './language.ts';

describe('Jarvis response language', () => {
  test('recognizes only languages the product currently supports', () => {
    expect(isJarvisLanguage('en')).toBe(true);
    expect(isJarvisLanguage('es')).toBe(true);
    expect(isJarvisLanguage('fr')).toBe(false);
    expect(isJarvisLanguage(null)).toBe(false);
  });

  test('normalizes BCP 47 locale variants and falls back safely', () => {
    expect(resolveJarvisLanguage('es-ES')).toBe('es');
    expect(resolveJarvisLanguage('es_MX')).toBe('es');
    expect(resolveJarvisLanguage('EN-us')).toBe('en');
    expect(resolveJarvisLanguage('fr-FR')).toBe('en');
    expect(resolveJarvisLanguage(undefined)).toBe('en');
  });

  test('builds a strict single-language response contract', () => {
    const prompt = buildResponseLanguageInstruction('es');
    expect(prompt).toContain('Use Spanish for every user-facing response.');
    expect(prompt).toContain('Stay in Spanish');
    expect(prompt).toContain('unless the user explicitly asks');
    expect(prompt).toContain('verbatim quotations may remain');
  });
});
