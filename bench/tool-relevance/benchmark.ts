#!/usr/bin/env bun
/**
 * Tool-relevance filter benchmark (#483 requirement 6).
 *
 * Two independent halves, because they have very different costs:
 *
 *   --tokens    (default) Offline. Computes the filtered set for every case
 *               and reports the schema-byte and token delta. Seconds.
 *   --accuracy  Sends each case to a real model twice, once with the full
 *               tool list and once with the filtered one, and scores which
 *               tool it picked. Needs a reachable model. HOURS on a local
 *               GPU -- see the cost note below.
 *
 * The exit criteria this has to answer are in
 * docs/tool-relevance-filtering.md section 10. The one that matters most is
 * the SUBSTITUTION RATE: how often filtering pushes the model from a framed
 * perception tool onto `run_command`. That number must be exactly zero, and
 * it is the measurement #475 never took.
 *
 * Usage:
 *   bun bench/tool-relevance/benchmark.ts
 *   bun bench/tool-relevance/benchmark.ts --accuracy --model ollama:qwen2.5:7b
 *   bun bench/tool-relevance/benchmark.ts --accuracy --limit 10 --base-url http://127.0.0.1:11434
 *
 * Why --model is required for --accuracy rather than read from the tier map:
 * the configured tiers on a given install are usually frontier models, which
 * the eligibility gate correctly refuses to filter. The harness pins its own
 * model so it measures the thing it is meant to measure.
 */

import type { LLMMessage } from '../../src/llm/provider.ts';
import type { ToolDefinition } from '../../src/actions/tools/registry.ts';
import { toolDefToLLMTool } from '../../src/actions/tools/builtin.ts';
import {
  isFloorEligible, isFramedPerception, isInvariantTrigger, outsideReach,
} from '../../src/actions/tools/tool-relevance/authority-classes.ts';
import { decideTools, invariantViolationCount, resetInvariantViolationCount } from '../../src/actions/tools/tool-relevance/filter.ts';
import { ToolExposureLedger } from '../../src/actions/tools/tool-relevance/ledger.ts';
import type { ToolFilterPolicy } from '../../src/actions/tools/tool-relevance/policy.ts';
import { buildProductionRegistry } from './registry.ts';
import { allCases, ISSUE_CASES, type BenchCase } from './cases.ts';

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const opt = (flag: string, fallback?: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const MODE_ACCURACY = has('--accuracy');
const MODEL_REF = opt('--model');
const BASE_URL = opt('--base-url', process.env.OLLAMA_HOST || 'http://127.0.0.1:11434')!;
const LIMIT = Number.parseInt(opt('--limit', '0')!, 10);
const ISSUE_ONLY = has('--issue-only');
/** Substring filter on case id, so a single expensive case can be re-run. */
const CASE_MATCH = opt('--case', '')!;
const FORCE_CPU = has('--cpu');
const NUM_CTX = Number.parseInt(opt('--num-ctx', '16384')!, 10) || 0;
const REQUEST_TIMEOUT_MS = Number.parseInt(opt('--timeout-s', '2400')!, 10) * 1000;

/**
 * Bytes per token for these schemas, measured against qwen38-fast (27.3B,
 * Q4_K) by comparing a real `prompt_eval_count` to the serialized byte
 * count. A plain bytes/4 estimate undercounts by about 8%, which matters
 * when the whole claim is a token number. Re-derive with --accuracy, which
 * prints the real counts.
 */
const BYTES_PER_TOKEN = 3.83;

/**
 * The pinned model, split once.
 *
 * Provider is everything before the FIRST colon; the model id keeps the
 * rest, because ollama tags contain colons ("qwen38-fast:latest"). Getting
 * this wrong is not a cosmetic bug: the eligibility gate compares
 * `provider:model` against the allowlist, so a mismatch makes the filtered
 * arm silently ineligible and both arms send the full list. The benchmark
 * then reports a 0% token delta and a large prefill "win" that is nothing
 * but the second call hitting a warm cache.
 */
const PINNED = (() => {
  if (!MODEL_REF) return { provider: 'bench', model: 'bench-model' };
  const i = MODEL_REF.indexOf(':');
  if (i <= 0) return { provider: 'bench', model: MODEL_REF };
  return { provider: MODEL_REF.slice(0, i), model: MODEL_REF.slice(i + 1) };
})();
const PINNED_REF = `${PINNED.provider}:${PINNED.model}`;

const FILTER_ON: ToolFilterPolicy = {
  enabled: true,
  maxParamsB: 1000,             // the harness pins its own model; do not size-gate it
  // Both the pinned ref AND the bare provider name. The gate also checks
  // the model-less candidate `tierCandidates` appends to recover a
  // provider's own default, which is unknowable and therefore ineligible;
  // allowlisting the bare name is how an operator says "whatever this
  // provider defaults to is fine". Without it the harness measures nothing
  // and its own guard refuses to print a number.
  models: [PINNED_REF, PINNED.provider],
};

// ------------------------------------------------------------------ helpers

const schemaBytes = (tools: readonly ToolDefinition[]) =>
  tools.reduce((n, t) => n + JSON.stringify(toolDefToLLMTool(t)).length, 0);
const estTokens = (bytes: number) => Math.round(bytes / BYTES_PER_TOKEN);
const pct = (a: number, b: number) => (b === 0 ? 0 : (100 * (a - b)) / b);
const pad = (s: string | number, n: number) => String(s).padStart(n);
const padr = (s: string | number, n: number) => String(s).padEnd(n);

function filteredFor(all: readonly ToolDefinition[], c: BenchCase) {
  const ledger = new ToolExposureLedger();
  const messages: LLMMessage[] = c.messages.map((m) => ({ role: 'user', content: m }));
  const d = decideTools({
    all, messages, ledger,
    tier: 'medium',
    tiers: { medium: { provider: PINNED.provider, model: PINNED.model } },
    providers: undefined,
    // Eligibility comes from the allowlist, which holds exactly the ref the
    // tier map above resolves to. See PINNED.
    policy: FILTER_ON,
  });
  // A benchmark whose "filtered" arm quietly fell back to the full list
  // measures nothing and reports it as a 0% delta. Refuse instead.
  if (!d.filtered && d.tools.length === all.length && d.reason !== 'selection kept everything') {
    throw new Error(
      `the filter did not engage (${d.reason}). The measurement would be meaningless; `
      + `check that --model matches the allowlisted ref ${PINNED_REF}.`,
    );
  }
  return d;
}

// ------------------------------------------------------------- token report

async function reportTokens(all: ToolDefinition[], skipped: string[]): Promise<void> {
  const cases = ISSUE_ONLY ? ISSUE_CASES : allCases(all);
  const fullBytes = schemaBytes(all);

  console.log(`\n=== Tool relevance: schema cost ===`);
  console.log(`registry: ${all.length} tools, ${fullBytes} B, ~${estTokens(fullBytes)} tok `
    + `(at ${BYTES_PER_TOKEN} B/tok, measured)`);
  if (skipped.length > 0) console.log(`NOT BUILT (numbers exclude these): ${skipped.join('; ')}`);

  const groups: Array<[string, (t: ToolDefinition) => boolean]> = [
    ['floor', isFloorEligible],
    ['framed perception', isFramedPerception],
    ['invariant triggers', isInvariantTrigger],
    ['replay', (t) => outsideReach(t) === 'replay'],
  ];
  console.log('');
  for (const [label, pred] of groups) {
    const g = all.filter(pred);
    console.log(`  ${padr(label, 20)} ${pad(g.length, 3)} tools  ${pad(schemaBytes(g), 6)} B`);
  }

  console.log(`\n=== Per case ===`);
  console.log(`${padr('case', 34)} ${pad('tools', 7)} ${pad('bytes', 7)} ${pad('tok', 6)} ${pad('saving', 8)}  triggers`);
  let sumFull = 0;
  let sumFiltered = 0;
  let worst = { id: '', saving: -Infinity };
  let best = { id: '', saving: Infinity };

  for (const c of cases) {
    const d = filteredFor(all, c);
    const b = schemaBytes(d.tools);
    sumFull += fullBytes;
    sumFiltered += b;
    const saving = pct(b, fullBytes);
    if (saving > worst.saving) worst = { id: c.id, saving };
    if (saving < best.saving) best = { id: c.id, saving };
    const trig = d.tools.filter(isInvariantTrigger).map((t) => t.name);
    console.log(
      `${padr(c.id, 34)} ${pad(`${d.tools.length}/${all.length}`, 7)} ${pad(b, 7)} ${pad(estTokens(b), 6)} `
      + `${pad(`${saving.toFixed(1)}%`, 8)}  ${trig.length ? trig.join(',') : '-'}`,
    );
  }

  console.log(`\naggregate over ${cases.length} cases: ${sumFiltered} / ${sumFull} B `
    + `= ${pct(sumFiltered, sumFull).toFixed(1)}%`);
  console.log(`best case:  ${best.id} ${best.saving.toFixed(1)}%`);
  console.log(`worst case: ${worst.id} ${worst.saving.toFixed(1)}%`);
  console.log(`invariant violations: ${invariantViolationCount()} (must be 0 to ship)`);
  console.log(`\nNOTE: these are SCHEMA bytes only. They do not account for prompt-cache`);
  console.log(`invalidation, which may exceed the saving -- run --accuracy for real counts.`);
}

// ---------------------------------------------------------- accuracy report

type OllamaReply = {
  message?: { tool_calls?: Array<{ function?: { name?: string } }> };
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
};

async function askModel(
  model: string, tools: readonly ToolDefinition[], messages: string[],
): Promise<{ called: string | null; promptTokens: number; prefillMs: number }> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    // Bun's fetch times out at 5 minutes by default. A cold full-tool-set
    // prefill on a 27B local model measured 646 s here, so the default
    // silently turns "slow but working" into "the benchmark cannot run".
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: messages.map((m) => ({ role: 'user', content: m })),
      tools: tools.map((t) => ({ type: 'function', function: toolDefToLLMTool(t) })),
      // --cpu forces CPU offload. The only local models on the reference box
      // are 27B and will not fit its GPU alongside anything else; CPU keeps
      // the harness usable there, at roughly an order of magnitude more
      // prefill time. Use it with --limit.
      // --num-ctx matters more than it looks. These models advertise a
      // 262144 context, and ollama sizes the KV cache for it: ~4.5 GB
      // before a single token is processed, which is enough to fail
      // allocation on both GPU and CPU on the reference box. The whole
      // measurement fits in 16k.
      ...(FORCE_CPU || NUM_CTX
        ? { options: { ...(FORCE_CPU ? { num_gpu: 0 } : {}), ...(NUM_CTX ? { num_ctx: NUM_CTX } : {}) } }
        : {}),
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json() as OllamaReply;
  return {
    called: body.message?.tool_calls?.[0]?.function?.name ?? null,
    promptTokens: body.prompt_eval_count ?? 0,
    prefillMs: Math.round((body.prompt_eval_duration ?? 0) / 1e6),
  };
}

async function reportAccuracy(all: ToolDefinition[]): Promise<void> {
  if (!MODEL_REF) {
    console.error('--accuracy needs --model <provider:model>, e.g. --model ollama:qwen2.5:7b');
    console.error('The configured tier map is deliberately NOT used: its models are usually');
    console.error('frontier ones, which the eligibility gate correctly refuses to filter.');
    process.exit(2);
  }
  const modelId = MODEL_REF.split(':').slice(1).join(':') || MODEL_REF;

  let cases = ISSUE_ONLY ? ISSUE_CASES : allCases(all);
  if (CASE_MATCH) cases = cases.filter((c) => c.id.includes(CASE_MATCH));
  if (LIMIT > 0) cases = cases.slice(0, LIMIT);
  if (cases.length === 0) {
    console.error(`no cases matched --case "${CASE_MATCH}"`);
    process.exit(2);
  }

  console.log(`\n=== Tool selection accuracy: ${modelId} via ${BASE_URL} ===`);
  console.log(`${cases.length} cases x 2 calls. A cold full-set prefill was measured at`);
  console.log(`~646 s on the reference box; budget accordingly or use --limit.\n`);

  const score = {
    fullCorrect: 0, filteredCorrect: 0,
    fullNoCall: 0, filteredNoCall: 0,
    substitutions: 0, framedCases: 0,
    hatchCalls: 0, errors: 0,
    fullTokens: 0, filteredTokens: 0,
    fullMs: 0, filteredMs: 0,
  };

  for (const c of cases) {
    const d = filteredFor(all, c);
    try {
      const full = await askModel(modelId, all, c.messages);
      const filtered = await askModel(modelId, d.tools, c.messages);

      score.fullTokens += full.promptTokens;
      score.filteredTokens += filtered.promptTokens;
      score.fullMs += full.prefillMs;
      score.filteredMs += filtered.prefillMs;
      if (full.called === null) score.fullNoCall += 1;
      if (filtered.called === null) score.filteredNoCall += 1;
      if (c.wants && full.called === c.wants) score.fullCorrect += 1;
      if (c.wants && filtered.called === c.wants) score.filteredCorrect += 1;
      if (filtered.called === 'discover_tools') score.hatchCalls += 1;

      // The metric that decides whether this ships: did filtering push the
      // model off a framed read and onto the shell?
      let substituted = false;
      if (c.wantsFramedRead) {
        score.framedCases += 1;
        substituted = filtered.called === 'run_command' && full.called !== 'run_command';
        if (substituted) score.substitutions += 1;
      }

      console.log(
        `${padr(c.id, 34)} full=${padr(full.called ?? '-', 20)} filtered=${padr(filtered.called ?? '-', 20)}`
        + ` ${pad(full.promptTokens, 6)}->${pad(filtered.promptTokens, 6)} tok`
        + (substituted ? '  *** SUBSTITUTION ***' : ''),
      );
    } catch (err) {
      score.errors += 1;
      console.log(`${padr(c.id, 34)} ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const n = cases.length - score.errors;
  console.log(`\n--- results over ${n} cases (${score.errors} errored) ---`);
  console.log(`correct tool:      full ${score.fullCorrect}/${n}   filtered ${score.filteredCorrect}/${n}`);
  console.log(`no tool called:    full ${score.fullNoCall}/${n}   filtered ${score.filteredNoCall}/${n}`);
  console.log(`prompt tokens:     full ${score.fullTokens}   filtered ${score.filteredTokens}`
    + `   (${pct(score.filteredTokens, score.fullTokens).toFixed(1)}%)`);
  console.log(`prefill ms:        full ${score.fullMs}   filtered ${score.filteredMs}`
    + `   (${pct(score.filteredMs, score.fullMs).toFixed(1)}%)`);
  console.log(`escape hatch used: ${score.hatchCalls}`);
  console.log(`SUBSTITUTIONS:     ${score.substitutions} over ${score.framedCases} framed-read cases`);
  console.log(`invariant violations: ${invariantViolationCount()}`);
  console.log('');

  // A run that measured nothing must never read as a pass. Zero
  // substitutions over zero cases is not evidence, and a harness that
  // reports it as "criteria met" is worse than one that does not run: it
  // manufactures exactly the unearned confidence #483 was filed about.
  if (n === 0) {
    console.log('NO RESULT: every case errored, so nothing was measured.');
    console.log('The exit criteria are UNPROVEN, not met. Fix the model endpoint and re-run.');
    process.exitCode = 1;
    return;
  }
  if (score.errors > 0) {
    console.log(`PARTIAL RESULT: ${score.errors} of ${cases.length} cases errored.`);
    console.log('Treat the criteria as unproven until a clean run.');
    process.exitCode = 1;
    return;
  }
  console.log(score.substitutions === 0 && invariantViolationCount() === 0
    ? 'Exit criteria: substitution rate and violation count are both zero.'
    : 'EXIT CRITERIA NOT MET: a nonzero substitution or violation count is a stop.');
  if (score.substitutions > 0 || invariantViolationCount() > 0) process.exitCode = 1;
  if (score.fullTokens > 0) {
    console.log(`Measured bytes/token for this model: `
      + `${(schemaBytes(all) / (score.fullTokens / Math.max(1, n))).toFixed(2)} (approximate)`);
  }
}

// ---------------------------------------------------------------------- run

const { tools, skipped } = await buildProductionRegistry();
resetInvariantViolationCount();
if (MODE_ACCURACY) await reportAccuracy(tools);
else await reportTokens(tools, skipped);
