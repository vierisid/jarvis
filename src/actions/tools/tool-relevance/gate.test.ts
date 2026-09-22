/**
 * The kill switch and the model-eligibility gate.
 *
 * #483 requirement 1 (frontier models unaffected) and defect 3 (no kill
 * switch in the product). The default-off posture is asserted first, because
 * everything else is moot if the filter can run without being asked for.
 */
import { describe, expect, test } from 'bun:test';
import type { TierMap } from '../../../llm/tiers.ts';
import {
  DISABLED_POLICY,
  envOverride,
  getToolFilterPolicy,
  resetToolFilterPolicy,
  setToolFilterPolicy,
  toolFilterPolicyFromConfig,
  type ToolFilterPolicy,
} from './policy.ts';
import { allReachableRefs, classifyModel, isTierEligible, parseParamsB, tierCandidateRefs } from './model-class.ts';

const ON: ToolFilterPolicy = { enabled: true, maxParamsB: 20, models: [] };

describe('default posture', () => {
  test('the process default is off', () => {
    resetToolFilterPolicy();
    expect(getToolFilterPolicy().enabled).toBe(false);
  });

  test('absent config means off', () => {
    expect(toolFilterPolicyFromConfig(undefined, {}).enabled).toBe(false);
    expect(toolFilterPolicyFromConfig({}, {}).enabled).toBe(false);
    expect(toolFilterPolicyFromConfig({ tools: {} }, {}).enabled).toBe(false);
    expect(toolFilterPolicyFromConfig({ tools: { relevance_filter: {} } }, {}).enabled).toBe(false);
  });

  test('only an explicit true turns it on', () => {
    for (const v of [false, undefined, null, 0, 1, 'true', 'yes']) {
      const cfg = { tools: { relevance_filter: { enabled: v as unknown as boolean } } };
      expect(`${String(v)}:${toolFilterPolicyFromConfig(cfg, {}).enabled}`).toBe(`${String(v)}:false`);
    }
    expect(toolFilterPolicyFromConfig({ tools: { relevance_filter: { enabled: true } } }, {}).enabled).toBe(true);
  });

  test('setToolFilterPolicy round-trips and reset restores off', () => {
    setToolFilterPolicy(ON);
    expect(getToolFilterPolicy().enabled).toBe(true);
    resetToolFilterPolicy();
    expect(getToolFilterPolicy()).toEqual(DISABLED_POLICY);
  });
});

describe('the kill switch', () => {
  const on = { tools: { relevance_filter: { enabled: true } } };

  test('JARVIS_TOOL_FILTER=off beats an enabled config', () => {
    expect(toolFilterPolicyFromConfig(on, { JARVIS_TOOL_FILTER: 'off' }).enabled).toBe(false);
    for (const v of ['off', 'OFF', ' Off ', '0', 'false', 'no']) {
      expect(`${v}:${toolFilterPolicyFromConfig(on, { JARVIS_TOOL_FILTER: v }).enabled}`).toBe(`${v}:false`);
    }
  });

  test('JARVIS_TOOL_FILTER=on enables it without a config file', () => {
    for (const v of ['on', 'ON', '1', 'true', 'yes']) {
      expect(`${v}:${toolFilterPolicyFromConfig(undefined, { JARVIS_TOOL_FILTER: v }).enabled}`).toBe(`${v}:true`);
    }
  });

  test('an unrecognised env value is ignored, not guessed at', () => {
    expect(envOverride({ JARVIS_TOOL_FILTER: 'maybe' })).toBeNull();
    expect(toolFilterPolicyFromConfig(on, { JARVIS_TOOL_FILTER: 'maybe' }).enabled).toBe(true);
    expect(toolFilterPolicyFromConfig(undefined, { JARVIS_TOOL_FILTER: 'maybe' }).enabled).toBe(false);
  });

  test('a malformed max_params_b falls back to the default rather than disabling the cap', () => {
    for (const bad of [0, -5, Number.NaN, 'twenty' as unknown as number, undefined]) {
      const p = toolFilterPolicyFromConfig(
        { tools: { relevance_filter: { enabled: true, max_params_b: bad } } }, {},
      );
      expect(`${String(bad)}:${p.maxParamsB}`).toBe(`${String(bad)}:20`);
    }
  });

  test('non-string entries in models are dropped', () => {
    const p = toolFilterPolicyFromConfig(
      { tools: { relevance_filter: { enabled: true, models: ['ollama:a:7b', '', 3 as unknown as string, '  ollama:b:8b  '] } } }, {},
    );
    expect(p.models).toEqual(['ollama:a:7b', 'ollama:b:8b']);
  });
});

describe('parameter tag parsing', () => {
  test('anchored tags parse', () => {
    expect(parseParamsB('qwen2.5:7b')).toBe(7);
    expect(parseParamsB('llama3.1-8b')).toBe(8);
    expect(parseParamsB('phi3_14b')).toBe(14);
    expect(parseParamsB('gemma-2b-it')).toBe(2);
    expect(parseParamsB('qwen-1.5b')).toBe(1.5);
  });

  test('the unsafe unanchored readings are rejected', () => {
    // An unanchored /(\d+)b/ reads these as 3B and 7B -- both far too small,
    // both in the direction that admits a big model as small.
    expect(parseParamsB('qwen3-30b-a3b')).toBe(30);
    expect(parseParamsB('mixtral-8x7b')).toBeNull();
  });

  test('an unparseable id has no tag', () => {
    expect(parseParamsB('qwen3-jarvis')).toBeNull();
    expect(parseParamsB('gpt-4o')).toBeNull();
    expect(parseParamsB('')).toBeNull();
  });
});

describe('model classification', () => {
  test('frontier models are never eligible', () => {
    for (const [provider, model] of [
      ['anthropic', 'claude-sonnet-4-6'], ['anthropic', 'claude-3-5-haiku'],
      ['openai', 'gpt-5.4'], ['openai', 'gpt-4o-mini'], ['gemini', 'gemini-2-pro'],
      ['usejarvis_ai', 'anything'], ['xai', 'grok-3'],
    ] as const) {
      const d = classifyModel({ provider, model }, provider, ON);
      expect(`${model}:${d.eligible}`).toBe(`${model}:false`);
    }
  });

  test('an unrecognised provider is treated as frontier', () => {
    // openai_compatible is how LM Studio, llama.cpp and vLLM arrive. They
    // carry no signal, so they are not auto-eligible; the allowlist is the
    // route for those deployments.
    expect(classifyModel({ provider: 'lmstudio', model: 'qwen2.5-7b' }, 'openai_compatible', ON).eligible).toBe(false);
    expect(classifyModel({ provider: 'mystery', model: 'something' }, undefined, ON).eligible).toBe(false);
  });

  test('a small ollama model is eligible and a large one is not', () => {
    expect(classifyModel({ provider: 'ollama', model: 'qwen2.5:7b' }, 'ollama', ON).eligible).toBe(true);
    // The models actually installed on the benchmark box are 27B and 30B.
    expect(classifyModel({ provider: 'ollama', model: 'qwen3:30b' }, 'ollama', ON).eligible).toBe(false);
    expect(classifyModel({ provider: 'ollama', model: 'qwen3.8:27b' }, 'ollama', ON).eligible).toBe(false);
  });

  test('an ollama model with no parseable size is not eligible', () => {
    // `qwen3-jarvis` is a real local tag on the benchmark box.
    expect(classifyModel({ provider: 'ollama', model: 'qwen3-jarvis' }, 'ollama', ON).eligible).toBe(false);
    expect(classifyModel({ provider: 'ollama', model: undefined }, 'ollama', ON).eligible).toBe(false);
  });

  test('a custom-named ollama instance is classified by kind, not name', () => {
    expect(classifyModel({ provider: 'ollama-remote', model: 'llama3.1:8b' }, 'ollama', ON).eligible).toBe(true);
  });

  test('the allowlist admits a model the heuristics would refuse', () => {
    const p: ToolFilterPolicy = { enabled: true, maxParamsB: 20, models: ['ollama:qwen3:30b'] };
    expect(classifyModel({ provider: 'ollama', model: 'qwen3:30b' }, 'ollama', p).eligible).toBe(true);
  });
});

describe('the tier gate and the failover hole', () => {
  const kinds = { ollama: { kind: 'ollama' as const }, openai: { kind: 'openai' as const } };

  test('a disabled policy is never eligible', () => {
    const tiers: TierMap = { low: { provider: 'ollama', model: 'qwen2.5:7b' } };
    expect(isTierEligible('low', tiers, kinds, DISABLED_POLICY).eligible).toBe(false);
  });

  test('an unconfigured tier is not eligible', () => {
    expect(isTierEligible('low', {}, kinds, ON).eligible).toBe(false);
  });

  test('a tier whose only candidate is a small ollama model is eligible', () => {
    const tiers: TierMap = { low: { provider: 'ollama', model: 'qwen2.5:7b' } };
    // `low` falls up to medium then high; neither is configured, so the only
    // candidate is the ollama one.
    expect(isTierEligible('low', tiers, kinds, ON).eligible).toBe(true);
  });

  test('a frontier FALL-UP candidate blocks filtering even when the tier itself is small', () => {
    // The hole: `low` is ollama, `medium` is frontier. chatTier walks the
    // fall-up chain on failure, so a filtered list computed for the small
    // model would be sent to the frontier one the moment ollama is down.
    const tiers: TierMap = {
      low: { provider: 'ollama', model: 'qwen2.5:7b' },
      medium: { provider: 'openai', model: 'gpt-5.4' },
    };
    expect(tierCandidateRefs('low', tiers)).toHaveLength(2);
    const d = isTierEligible('low', tiers, kinds, ON);
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain('failover candidate');
  });

  test('all-small fall-up chain stays eligible', () => {
    const tiers: TierMap = {
      low: { provider: 'ollama', model: 'qwen2.5:7b' },
      medium: { provider: 'ollama', model: 'llama3.1:8b' },
    };
    expect(isTierEligible('low', tiers, kinds, ON).eligible).toBe(true);
  });

  test('the conversation tier never falls up, so it is judged alone', () => {
    const tiers: TierMap = {
      conversation: { provider: 'ollama', model: 'qwen2.5:7b' },
      medium: { provider: 'openai', model: 'gpt-5.4' },
    };
    expect(tierCandidateRefs('conversation', tiers)).toEqual([{ provider: 'ollama', model: 'qwen2.5:7b' }]);
    expect(isTierEligible('conversation', tiers, kinds, ON).eligible).toBe(true);
  });

  test('a caller-supplied fallbackTier is classified too', () => {
    // The hole TIER_FALLBACK cannot see. agent-service calls
    // streamMessage(..., 'conversation', 'chat_orchestrator_image', 'medium'),
    // and TIER_FALLBACK.conversation is deliberately EMPTY because the
    // conversation tier's presence is a mode switch, not a fall-up. So
    // tierCandidateRefs('conversation') never contains the medium
    // assignment, and a gate built on it alone clears a small local
    // conversation model and then hands the filtered list to the frontier
    // task model the instant the local one errors before first output.
    const tiers: TierMap = {
      conversation: { provider: 'ollama', model: 'qwen2.5:7b' },
      medium: { provider: 'openai', model: 'gpt-5.4' },
    };
    expect(tierCandidateRefs('conversation', tiers)).toHaveLength(1);
    expect(isTierEligible('conversation', tiers, kinds, ON).eligible).toBe(true);

    expect(allReachableRefs('conversation', 'medium', tiers)).toHaveLength(2);
    const d = isTierEligible('conversation', tiers, kinds, ON, 'medium');
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain('failover candidate');
  });

  test('an all-local conversation plus fallback stays eligible', () => {
    const tiers: TierMap = {
      conversation: { provider: 'ollama', model: 'qwen2.5:7b' },
      medium: { provider: 'ollama', model: 'llama3.1:8b' },
    };
    expect(isTierEligible('conversation', tiers, kinds, ON, 'medium').eligible).toBe(true);
  });

  test('a fallbackTier equal to the tier changes nothing', () => {
    const tiers: TierMap = { medium: { provider: 'ollama', model: 'qwen2.5:7b' } };
    expect(allReachableRefs('medium', 'medium', tiers)).toHaveLength(1);
    expect(isTierEligible('medium', tiers, kinds, ON, 'medium').eligible).toBe(true);
  });

  test("a cloud provider's own default model is a candidate, and blocks filtering", () => {
    // `tierCandidates` appends the same provider with NO model alongside
    // each assignment, to recover the provider's default before crossing a
    // provider boundary. When the pinned model 404s, chatTier deletes
    // options.model and retries -- and that default is unknowable here,
    // since LLMProvider exposes only `name`. An unclassifiable candidate
    // must therefore block, or an allowlisted "gw:small-7b" would hand the
    // filtered list to whatever the gateway defaults to.
    const tiers: TierMap = { medium: { provider: 'gw', model: 'small-7b' } };
    const kindsGw = { gw: { kind: 'openai' as const } };
    const allowlisted: ToolFilterPolicy = { enabled: true, maxParamsB: 20, models: ['gw:small-7b'] };
    const d = isTierEligible('medium', tiers, kindsGw, allowlisted);
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain('no model id');
  });

  test('a placeholder-default provider has no model-less candidate, so ollama still filters', () => {
    // The manager skips the model-less candidate for providers whose
    // built-in default is only a guess (ollama, openai_compatible,
    // litellm). Mirroring that is what keeps the feature usable at all:
    // without it, nothing would ever be eligible.
    const tiers: TierMap = { medium: { provider: 'ollama', model: 'qwen2.5:7b' } };
    expect(isTierEligible('medium', tiers, kinds, ON).eligible).toBe(true);
  });

  test('allowlisting the bare provider name clears its default model', () => {
    const tiers: TierMap = { medium: { provider: 'gw', model: 'small-7b' } };
    const kindsGw = { gw: { kind: 'openai' as const } };
    const p: ToolFilterPolicy = { enabled: true, maxParamsB: 20, models: ['gw:small-7b', 'gw'] };
    expect(isTierEligible('medium', tiers, kindsGw, p).eligible).toBe(true);
  });

  test('the environment configured on this machine is not eligible', () => {
    // All four tiers point at openai:gpt-5.4* here, so the filter cannot
    // engage even with enabled: true. The benchmark has to pin its own model.
    const tiers: TierMap = {
      conversation: { provider: 'openai', model: 'gpt-5.4' },
      high: { provider: 'openai', model: 'gpt-5.4' },
      medium: { provider: 'openai', model: 'gpt-5.4' },
      low: { provider: 'openai', model: 'gpt-5.4-mini' },
    };
    for (const t of ['conversation', 'high', 'medium', 'low'] as const) {
      expect(`${t}:${isTierEligible(t, tiers, kinds, ON).eligible}`).toBe(`${t}:false`);
    }
  });
});
