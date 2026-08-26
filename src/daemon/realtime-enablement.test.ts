import { describe, expect, test } from 'bun:test';
import { effectiveRealtimeEnabled } from './usejarvis-ai.ts';
import { resolveRealtimeVoice } from '../config/realtime.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * Who gets realtime, and who decides.
 *
 * The bug this fixes: `voice.realtime.enabled` defaults to false and only the
 * JARVIS_REALTIME_VOICE env var flipped it, so the hosted branch of
 * resolveRealtimeVoice — which dials the uj-realtime alias — never ran for a
 * single hosted tenant, however much their plan included it.
 */

const hosted = (over: Record<string, unknown> = {}): JarvisConfig =>
  ({
    usejarvis_ai: { base_url: 'https://llm.example/v1', api_key: 'sk-uj-x' },
    llm: { providers: {} },
    ...over,
  }) as unknown as JarvisConfig;

const selfHosted = (over: Record<string, unknown> = {}): JarvisConfig =>
  ({ llm: { providers: {} }, ...over }) as unknown as JarvisConfig;

/** Stands in for the vault row `cfg.voice`. undefined = never saved. */
const stored = (value: unknown) => () => value;

describe('who realtime is on for', () => {
  test('a hosted tenant who never opened the Voice tab gets it', () => {
    // This is the whole fix. They have no stored `voice` section at all, and
    // DEFAULT_CONFIG's false is not their answer — it is the absence of one.
    expect(effectiveRealtimeEnabled(hosted(), stored(undefined))).toBe(true);
  });

  test('a self-hosted install is untouched — realtime spends the USER\'s money', () => {
    // BYO realtime bills their own OpenAI account, so it must never switch
    // itself on. Only the explicit opt-in counts.
    expect(effectiveRealtimeEnabled(selfHosted(), stored(undefined))).toBe(false);
    expect(
      effectiveRealtimeEnabled(selfHosted({ voice: { realtime: { enabled: true } } }), stored(undefined)),
    ).toBe(true);
  });

  test('an explicit user choice wins in BOTH directions', () => {
    // Off: someone who prefers the standard pipeline keeps it, even on a plan
    // that includes realtime.
    expect(effectiveRealtimeEnabled(hosted(), stored({ realtime: { enabled: false } }))).toBe(false);
    expect(effectiveRealtimeEnabled(hosted(), stored({ realtime: { enabled: true } }))).toBe(true);
  });

  test('an unreadable vault leaves realtime as configured, rather than switching it on', () => {
    // The user's answer lives only in the vault. If it cannot be read we
    // cannot tell "declined" from "never asked" — and turning realtime on for
    // someone who switched it off opens a billed audio session to do it.
    const throwing = () => { throw new Error('vault not open'); };
    expect(effectiveRealtimeEnabled(hosted(), throwing)).toBe(false);
    expect(
      effectiveRealtimeEnabled(hosted({ voice: { realtime: { enabled: true } } }), throwing),
    ).toBe(true);
  });

  test('an explicit true costs no vault read at all', () => {
    // DEFAULT_CONFIG says false, so a true in the merged config can only have
    // come from the user or the env — nothing left to disambiguate.
    let reads = 0;
    const counting = () => { reads++; return undefined; };
    expect(
      effectiveRealtimeEnabled(hosted({ voice: { realtime: { enabled: true } } }), counting),
    ).toBe(true);
    expect(reads).toBe(0);
  });

  test('only a PERSISTED boolean counts as a choice', () => {
    // The merged config always carries a boolean (DEFAULT_CONFIG sets false),
    // so reading it there cannot tell "turned it off" from "never touched" —
    // the same trap effectiveTtsForBinding documents for Edge. A stored voice
    // row that says nothing about realtime is not an answer.
    expect(effectiveRealtimeEnabled(hosted(), stored({ wake_engine: 'openwakeword' }))).toBe(true);
    expect(effectiveRealtimeEnabled(hosted(), stored({ realtime: {} }))).toBe(true);
    expect(effectiveRealtimeEnabled(hosted(), stored({ realtime: { enabled: 'yes' } }))).toBe(true);
    expect(effectiveRealtimeEnabled(hosted(), stored(null))).toBe(true);
    expect(effectiveRealtimeEnabled(hosted(), stored([1, 2]))).toBe(true);
  });
});

describe('resolving a session from that decision', () => {
  test('a hosted tenant with NO voice block resolves against the uj-realtime alias', () => {
    // The block being absent is the normal state for the tenant this fixes,
    // and every field below has to survive it.
    const res = resolveRealtimeVoice(hosted(), true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.provider).toBe('usejarvis_ai');
    expect(res.resolved.model).toBe('uj-realtime');
    expect(res.resolved.url).toBe('wss://llm.example/v1/realtime');
    // The plan gate reads this; without it every session is allowed blind.
    expect(res.resolved.modelsUrl).toBe('https://llm.example/v1/models');
    expect(res.resolved.maxSessionMinutes).toBe(10);
    expect(res.resolved.reasoningEffort).toBe('low');
    // The local $/min estimate must not double-block a hosted session.
    expect(res.resolved.monthlyBudgetUsd).toBeUndefined();
    // The destructive-action backstop still applies with no block to read it
    // from — an open mic must not be able to auto-approve a payment.
    expect(res.resolved.blockedCategories.length).toBeGreaterThan(0);
  });

  test('a false decision refuses, whatever the config says', () => {
    const res = resolveRealtimeVoice(hosted({ voice: { realtime: { enabled: true } } }), false);
    expect(res.ok).toBe(false);
  });

  test('the default argument is the raw config value', () => {
    // Callers without the vault DB (and every pre-existing test) must see the
    // old behaviour rather than a silent hosted-on.
    expect(resolveRealtimeVoice(hosted()).ok).toBe(false);
    expect(resolveRealtimeVoice(hosted({ voice: { realtime: { enabled: true } } })).ok).toBe(true);
  });

  test('a BYO OpenAI key still wins over the hosted alias', () => {
    // Their explicit choice, their own spend — unchanged by this work.
    const res = resolveRealtimeVoice(
      hosted({ llm: { providers: { openai: { api_key: 'sk-real' } } } }),
      true,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.provider).toBe('openai');
    expect(res.resolved.model).toBe('gpt-realtime-2');
  });
});
