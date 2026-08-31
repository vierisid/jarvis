import { describe, expect, test } from 'bun:test';
import { hasUsejarvisAi, realtimeEnablement, resetRealtimeVaultWarningForTest } from './usejarvis-ai.ts';
import { realtimeServedByPlan, resolveRealtimeVoice } from '../config/realtime.ts';
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
    expect(realtimeEnablement(hosted(), stored(undefined))).toBe('hosted-default');
  });

  test('a self-hosted install is untouched — realtime spends the USER\'s money', () => {
    // BYO realtime bills their own OpenAI account, so it must never switch
    // itself on. Only the explicit opt-in counts.
    expect(realtimeEnablement(selfHosted(), stored(undefined))).toBe('off');
    expect(
      realtimeEnablement(selfHosted({ voice: { realtime: { enabled: true } } }), stored(undefined)),
    ).toBe('user-on');
  });

  test('an explicit user choice wins in BOTH directions', () => {
    // Off: someone who prefers the standard pipeline keeps it, even on a plan
    // that includes realtime.
    expect(realtimeEnablement(hosted(), stored({ realtime: { enabled: false } }))).toBe('off');
    expect(realtimeEnablement(hosted(), stored({ realtime: { enabled: true } }))).toBe('user-on');
  });

  test('an unreadable vault leaves realtime as configured, rather than switching it on', () => {
    // The user's answer lives only in the vault. If it cannot be read we
    // cannot tell "declined" from "never asked" — and turning realtime on for
    // someone who switched it off opens a billed audio session to do it.
    const throwing = () => { throw new Error('vault not open'); };
    expect(realtimeEnablement(hosted(), throwing)).toBe('off');
    expect(
      realtimeEnablement(hosted({ voice: { realtime: { enabled: true } } }), throwing),
    ).toBe('user-on');
  });

  test('an explicit true costs no vault read at all', () => {
    // DEFAULT_CONFIG says false, so a true in the merged config can only have
    // come from the user or the env — nothing left to disambiguate.
    let reads = 0;
    const counting = () => { reads++; return undefined; };
    expect(
      realtimeEnablement(hosted({ voice: { realtime: { enabled: true } } }), counting),
    ).toBe('user-on');
    expect(reads).toBe(0);
  });

  test('only a PERSISTED boolean counts as a choice', () => {
    // The merged config always carries a boolean (DEFAULT_CONFIG sets false),
    // so reading it there cannot tell "turned it off" from "never touched" —
    // the same trap effectiveTtsForBinding documents for Edge. A stored voice
    // row that says nothing about realtime is not an answer.
    expect(realtimeEnablement(hosted(), stored({ wake_engine: 'openwakeword' }))).toBe('hosted-default');
    expect(realtimeEnablement(hosted(), stored({ realtime: {} }))).toBe('hosted-default');
    expect(realtimeEnablement(hosted(), stored({ realtime: { enabled: 'yes' } }))).toBe('hosted-default');
    expect(realtimeEnablement(hosted(), stored(null))).toBe('hosted-default');
    expect(realtimeEnablement(hosted(), stored([1, 2]))).toBe('hosted-default');
  });
});

describe('resolving a session from that decision', () => {
  test('a hosted tenant with NO voice block resolves against the uj-realtime alias', () => {
    // The block being absent is the normal state for the tenant this fixes,
    // and every field below has to survive it.
    const res = resolveRealtimeVoice(hosted(), 'hosted-default');
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
    const res = resolveRealtimeVoice(hosted({ voice: { realtime: { enabled: true } } }), 'off');
    expect(res.ok).toBe(false);
  });

  test('the default argument is the raw config value', () => {
    // Callers without the vault DB (and every pre-existing test) must see the
    // old behaviour rather than a silent hosted-on.
    expect(resolveRealtimeVoice(hosted()).ok).toBe(false);
    expect(resolveRealtimeVoice(hosted({ voice: { realtime: { enabled: true } } })).ok).toBe(true);
  });

  test('a SELF-HOSTED install still uses the BYO key', () => {
    // Nothing else can serve it there, and it is their explicit choice.
    const res = resolveRealtimeVoice(
      selfHosted({ llm: { providers: { openai: { api_key: 'sk-real' } } } }),
      'user-on',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.provider).toBe('openai');
    expect(res.resolved.model).toBe('gpt-realtime-2');
  });
});

describe('the money boundary — a default-on session must never touch a BYO key', () => {
  test('a hosted tenant with a personal OpenAI key resolves to the HOSTED alias, not theirs', () => {
    // The regression this guards: hosted installs allow BYO providers for
    // chat. A tenant who added one and never opened the Voice tab would, under
    // a plain boolean enablement, have every voice turn dialled against
    // api.openai.com on THEIR key at ~$0.30/min — ungated (the plan gate skips
    // BYO sessions, which have no modelsUrl) and unbudgeted (they never set a
    // cap), having opted into none of it.
    const cfg = hosted({ llm: { providers: { openai: { api_key: 'sk-their-own' } } } });
    expect(realtimeEnablement(cfg, stored(undefined))).toBe('hosted-default');
    const res = resolveRealtimeVoice(cfg, 'hosted-default');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.provider).toBe('usejarvis_ai');
    expect(res.resolved.apiKey).not.toBe('sk-their-own');
    // modelsUrl present = the plan gate applies. Its absence is what made the
    // BYO path ungated in the first place.
    expect(res.resolved.modelsUrl).toBeTruthy();
  });

  test('and an EXPLICIT yes does not re-open the door', () => {
    // Scoping the rule to `hosted-default` alone left the harm one click away:
    // toggling realtime off and on again makes the tenant `user-on`, and their
    // own key would have won from then on — while the settings tab told them
    // realtime was included in their plan. On a hosted install the plan serves
    // it whoever asked.
    const cfg = hosted({
      voice: { realtime: { enabled: true } },
      llm: { providers: { openai: { api_key: 'sk-their-own' } } },
    });
    expect(realtimeEnablement(cfg, stored(undefined))).toBe('user-on');
    const res = resolveRealtimeVoice(cfg, 'user-on');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.provider).toBe('usejarvis_ai');
    expect(res.resolved.apiKey).not.toBe('sk-their-own');
    expect(res.resolved.modelsUrl).toBeTruthy(); // and the plan gate applies
  });

  test('a hosted tenant whose plan EXCLUDES realtime is refused, not billed', () => {
    // The accepted cost of the rule above: their own key is not reached, so
    // the gate refuses and they fall back to the standard pipeline. Losing a
    // rare capability beats silently charging someone's personal card.
    const cfg = hosted({
      voice: { realtime: { enabled: true } },
      llm: { providers: { openai: { api_key: 'sk-their-own' } } },
    });
    const res = resolveRealtimeVoice(cfg, 'user-on');
    // Resolution succeeds; the CATALOG gate is what says no at session start,
    // and it only applies because modelsUrl is present.
    expect(res.ok && res.resolved.modelsUrl).toBeTruthy();
  });
});

describe('the operator kill switch', () => {
  const KEY = 'JARVIS_REALTIME_VOICE';
  const restore = (v: string | undefined) => {
    if (v === undefined) delete process.env[KEY];
    else process.env[KEY] = v;
  };

  test('JARVIS_REALTIME_VOICE=0 still disables realtime on a hosted install', () => {
    // loader.ts applies the env override LAST over every merge and documents
    // "0"/"false" as an explicit disable. It is the lever an operator reaches
    // for to stop opening billed audio sessions fleet-wide — which matters
    // most on exactly the fleet where realtime just became default-on.
    const before = process.env[KEY];
    try {
      process.env[KEY] = '0';
      // The loader has already turned "0" into enabled:false in the merged
      // config; what must not happen is the hosted default overriding it.
      expect(realtimeEnablement(hosted(), stored(undefined))).toBe('off');
      expect(realtimeEnablement(hosted(), stored({ realtime: { enabled: true } }))).toBe('off');
    } finally {
      restore(before);
    }
  });

  test('with the var UNSET the hosted default still applies', () => {
    const before = process.env[KEY];
    try {
      delete process.env[KEY];
      expect(realtimeEnablement(hosted(), stored(undefined))).toBe('hosted-default');
    } finally {
      restore(before);
    }
  });
});

describe('the two hosted predicates must never disagree', () => {
  // realtimeEnablement keys off hasUsejarvisAi; the resolver and the settings
  // route key off realtimeServedByPlan. If they diverge, enablement can say
  // "hosted, default it on" while the resolver reads a BYO key — which is the
  // billing bug this series exists to close — or the reverse, where a hosted
  // tenant is told they pay OpenAI for something the plan serves.
  const cases: Array<[string, unknown]> = [
    ['absent', undefined],
    ['complete', { base_url: 'https://llm.example/v1', api_key: 'sk-uj-x' }],
    ['empty api_key', { base_url: 'https://llm.example/v1', api_key: '' }],
    ['whitespace api_key', { base_url: 'https://llm.example/v1', api_key: '   ' }],
    ['empty base_url', { base_url: '', api_key: 'sk-uj-x' }],
    ['whitespace base_url', { base_url: '  ', api_key: 'sk-uj-x' }],
    ['slashes-only base_url', { base_url: '///', api_key: 'sk-uj-x' }],
    ['missing api_key', { base_url: 'https://llm.example/v1' }],
    // The documented YAML hazard: an unquoted scalar parses as a number or a
    // boolean. Reaching for .trim() on those threw a TypeError, and the
    // settings route calls this predicate outside its try/catch.
    ['numeric base_url', { base_url: 8080, api_key: 'sk-uj-x' }],
    ['boolean api_key', { base_url: 'https://llm.example/v1', api_key: true }],
    ['null block', null],
    ['array block', []],
  ];

  for (const [name, block] of cases) {
    test(`agree on: ${name}`, () => {
      const cfg = { llm: { providers: {} }, usejarvis_ai: block } as unknown as JarvisConfig;
      expect(() => realtimeServedByPlan(cfg)).not.toThrow();
      expect(realtimeServedByPlan(cfg)).toBe(hasUsejarvisAi(cfg));
    });
  }
});

describe('a mistyped config block does not flood the log', () => {
  test('the malformed-block warning fires ONCE, not per read', () => {
    // A hosted dashboard polls GET /api/config/voice every ~15s and each read
    // runs hasUsejarvisAi, so one unquoted YAML scalar would print four times
    // a minute for the life of the daemon.
    resetRealtimeVaultWarningForTest();
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const cfg = {
        llm: { providers: {} },
        usejarvis_ai: { base_url: 8080, api_key: 'sk-uj-x' },
      } as unknown as JarvisConfig;
      for (let i = 0; i < 5; i++) hasUsejarvisAi(cfg);
      expect(warnings.filter((w) => w.includes('malformed usejarvis_ai'))).toHaveLength(1);
    } finally {
      console.warn = realWarn;
      resetRealtimeVaultWarningForTest();
    }
  });
});
