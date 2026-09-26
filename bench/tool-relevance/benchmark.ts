#!/usr/bin/env bun
/**
 * Tool-relevance filter benchmark (#483 requirement 6).
 *
 * Three parts, because they have very different costs:
 *
 *   --tokens    (default) Offline. Computes the filtered set for every case
 *               and reports the schema-byte delta, plus an ESTIMATE of what
 *               survives prompt caching over scripted multi-turn
 *               conversations. Seconds, no model.
 *   --accuracy  Sends each case to a real model twice, once with the full
 *               tool list and once with the filtered one, and scores which
 *               tool it picked. A `discover_tools` call is answered and the
 *               model asked again, so the escape hatch is scored on whether
 *               it recovered, not on whether it was reached.
 *   --cache     Replays the scripted conversations turn by turn, one arm at
 *               a time, and sums the prompt tokens the server actually had
 *               to evaluate. This is the cache-accounted saving.
 *   --live      --accuracy then --cache: every live number the default flip
 *               needs, in one command.
 *
 * The exit criteria this has to answer are in
 * docs/tool-relevance-filtering.md section 10. The one that matters most is
 * the SUBSTITUTION RATE: how often filtering pushes the model from a framed
 * perception tool onto an unframed fetch tool. That number must be exactly
 * zero, and it is the measurement #475 never took.
 *
 * Usage:
 *   bun bench/tool-relevance/benchmark.ts
 *   bun bench/tool-relevance/benchmark.ts --live --model ollama:qwen2.5:7b
 *   bun bench/tool-relevance/benchmark.ts --live --api openai \
 *     --base-url http://127.0.0.1:8080/v1 --model llamacpp:qwen2.5-7b-instruct
 *   bun bench/tool-relevance/benchmark.ts --accuracy --api openai \
 *     --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY \
 *     --model openrouter:qwen/qwen-2.5-7b-instruct --max-calls 350
 *
 * Why --model is required for the live modes rather than read from the tier
 * map: the configured tiers on a given install are usually frontier models,
 * which the eligibility gate correctly refuses to filter. The harness pins
 * its own model so it measures the thing it is meant to measure.
 */

import { readFileSync } from 'node:fs';
import type { LLMMessage } from '../../src/llm/provider.ts';
import type { ToolDefinition } from '../../src/actions/tools/registry.ts';
import { toolDefToLLMTool } from '../../src/actions/tools/builtin.ts';
import { buildToolGuide } from '../../src/roles/tool-guide.ts';
import {
  isFloorEligible, isFramedPerception, isInvariantTrigger, outsideReach,
} from '../../src/actions/tools/tool-relevance/authority-classes.ts';
import { decideTools, invariantViolationCount, resetInvariantViolationCount } from '../../src/actions/tools/tool-relevance/filter.ts';
import { DISCOVER_TOOLS, ToolExposureLedger } from '../../src/actions/tools/tool-relevance/ledger.ts';
import { DISCOVER_TOOLS_LLM, handleDiscoverTools, interceptOffList } from '../../src/actions/tools/tool-relevance/discover.ts';
import type { ToolFilterPolicy } from '../../src/actions/tools/tool-relevance/policy.ts';
import { buildProductionRegistry } from './registry.ts';
import { allCases, CONVERSATIONS, ISSUE_CASES, type BenchCase, type ScriptedConversation } from './cases.ts';
import {
  accuracyRunVerdict, accuracyVerdict, CACHE_MODELS, isFilterSubstitution, isUnframedFetch, uncachedBytes,
  type CacheStep,
} from './metrics.ts';
import {
  normalizeOllamaHost, parseCount, parseOllamaReply, parseOpenAIReply, type Reply, type ToolCallOut,
} from './protocol.ts';

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const opt = (flag: string, fallback?: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const MODE_LIVE = has('--live');
const MODE_ACCURACY = MODE_LIVE || has('--accuracy');
const MODE_CACHE = MODE_LIVE || has('--cache');
const MODEL_REF = opt('--model');
/**
 * Wire protocol. `ollama` speaks /api/chat; `openai` speaks
 * /chat/completions, which is what llama.cpp's llama-server, LM Studio,
 * vLLM and OpenRouter all expose -- so a 7-8B model is reachable without
 * ollama at all.
 */
const API = opt('--api', 'ollama')!;
const BASE_URL = (opt('--base-url')
  ?? (API === 'ollama' ? normalizeOllamaHost(process.env.OLLAMA_HOST || '127.0.0.1:11434') : 'http://127.0.0.1:8080/v1'))
  .replace(/\/+$/, '');
/**
 * NAME of the env var holding the API key, never the key itself: a key on
 * the command line lands in shell history and in `ps` output.
 */
const API_KEY_ENV = opt('--api-key-env');
/** A malformed number exits 2 rather than silently becoming NaN (which removed the --max-calls cap). */
const count = (flag: string, fallback: string): number => {
  try {
    return parseCount(flag, opt(flag, fallback)!);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
};
const LIMIT = count('--limit', '0');
const ISSUE_ONLY = has('--issue-only');
/** Substring filter on case id, so a single expensive case can be re-run. */
const CASE_MATCH = opt('--case', '')!;
const FORCE_CPU = has('--cpu');
const NUM_CTX = count('--num-ctx', '16384');
const REQUEST_TIMEOUT_MS = count('--timeout-s', '2400') * 1000;
/**
 * The live --cache run's shape: a fresh ledger and history per scripted
 * conversation (the task/sub-agent loops), or `--one-session` for one
 * ledger and one history across all of them (the chat loops).
 */
const ONE_SESSION = has('--one-session');
/** Narrowed runs are smoke tests. They never print "ALL THREE ... MET". */
const SUBSET = has('--issue-only') || has('--case') || has('--limit');
/**
 * Hard ceiling on provider calls for the whole run. The planned count is
 * printed before the first call; a run that would exceed this refuses to
 * start rather than stopping halfway, so a paid endpoint cannot be billed for
 * a partial result that the harness will then refuse to read.
 */
const MAX_CALLS = count('--max-calls', '1000');
/** `discover_tools` rounds and off-list refusals answered per case before the model must commit. */
const MAX_HATCH_ROUNDS = 2;

/**
 * Bytes per token for these schemas, measured against qwen38-fast (27.3B,
 * Q4_K) by comparing a real `prompt_eval_count` to the serialized byte
 * count. A plain bytes/4 estimate undercounts by about 8%, which matters
 * when the whole claim is a token number. Re-derive from a live run's
 * "prompt tokens sent" (a total the server reports), never from evaluated
 * counts, which exclude whatever the cache served.
 */
const BYTES_PER_TOKEN = 3.83;

/**
 * The system prompt both arms carry.
 *
 * Production never sends a bare tool list: the static prompt carries the
 * Tool Guide (src/roles/tool-guide.ts), which documents `run_command` and
 * the browser tools BY NAME whatever the filter offered. That is exactly the
 * condition under which a small model calls a tool it was not offered, so a
 * substitution measured without it is measured on an easier problem than
 * the real one. `--system-file` substitutes a captured production prompt;
 * `--no-system` reproduces the pre-#483-closeout harness.
 */
const SYSTEM_PROMPT: string | null = (() => {
  if (has('--no-system')) return null;
  const file = opt('--system-file');
  if (file) return readFileSync(file, 'utf8');
  return buildToolGuide({ hasSidecars: false, piecesManaged: false });
})();

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

const wireTool = (t: ToolDefinition) => (t.name === DISCOVER_TOOLS ? DISCOVER_TOOLS_LLM : toolDefToLLMTool(t));
const schemaBytes = (tools: readonly ToolDefinition[]) =>
  tools.reduce((n, t) => n + JSON.stringify(wireTool(t)).length, 0);
const estTokens = (bytes: number) => Math.round(bytes / BYTES_PER_TOKEN);
const pct = (a: number, b: number) => (b === 0 ? 0 : (100 * (a - b)) / b);
const pad = (s: string | number, n: number) => String(s).padStart(n);
const padr = (s: string | number, n: number) => String(s).padEnd(n);
const systemMessages = (): LLMMessage[] => (SYSTEM_PROMPT ? [{ role: 'system', content: SYSTEM_PROMPT }] : []);

function decideFor(all: readonly ToolDefinition[], messages: readonly LLMMessage[], ledger: ToolExposureLedger) {
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
  if (d.reason === 'invariant violation' || d.reason === 'filter threw' || d.reason === 'escape hatch missing') {
    // Not a configuration problem: the filter failed open. Criterion 4.
    throw new Error(`INVARIANT VIOLATION: the filter failed open (${d.reason}): `
      + d.failures.map((f) => `${f.invariant}: ${f.detail}`).join(' | '));
  }
  if (!d.filtered && d.tools.length === all.length && d.reason !== 'selection kept everything') {
    throw new Error(
      `the filter did not engage (${d.reason}). The measurement would be meaningless; `
      + `check that --model matches the allowlisted ref ${PINNED_REF}.`,
    );
  }
  return d;
}

const caseMessages = (c: BenchCase): LLMMessage[] =>
  [...systemMessages(), ...c.messages.map((m): LLMMessage => ({ role: 'user', content: m }))];

function selectedCases(all: readonly ToolDefinition[]): BenchCase[] {
  let cases = ISSUE_ONLY ? ISSUE_CASES : allCases(all);
  if (CASE_MATCH) cases = cases.filter((c) => c.id.includes(CASE_MATCH));
  if (LIMIT > 0) cases = cases.slice(0, LIMIT);
  return cases;
}

// ------------------------------------------------------------- token report

/**
 * Offline cache estimate: every scripted conversation, in order, per arm.
 * See `uncachedBytes` for the model and for why it is only an estimate.
 *
 * Two shapes, because the loops differ and the answer differs with them:
 *
 *   separate    a fresh history and a fresh ledger per conversation, the
 *               way the task and sub-agent loops start. Pessimistic for the
 *               filter: every conversation starts on a different set.
 *   one session one history and one ledger across all of them, the way the
 *               chat loops run (`ledgerFor(primary.id)` outlives any single
 *               exchange). The set only grows, so it settles and changes
 *               less -- and saves less.
 */
function cacheSteps(
  all: readonly ToolDefinition[],
  convs: readonly ScriptedConversation[],
  filtered: boolean,
  oneSession: boolean,
): { steps: CacheStep[]; changes: number } {
  const steps: CacheStep[] = [];
  const systemBytes = SYSTEM_PROMPT?.length ?? 0;
  let changes = 0;
  let prevTools: string[] | null = null;
  let ledger = new ToolExposureLedger();
  let history: LLMMessage[] = [];
  convs.forEach((conv, ci) => {
    if (!oneSession) {
      ledger = new ToolExposureLedger();
      history = [];
    }
    conv.turns.forEach((turn, i) => {
      history.push({ role: 'user', content: turn.user });
      const tools = filtered ? decideFor(all, [...systemMessages(), ...history], ledger).tools : [...all];
      const names = tools.map((t) => t.name);
      if (prevTools && names.join() !== prevTools.join()) changes += 1;
      prevTools = names;
      steps.push({
        tools: names,
        toolSizes: tools.map((t) => schemaBytes([t])),
        systemBytes,
        messageBytes: history.map((m) => (typeof m.content === 'string' ? m.content.length : 0)),
        newConversation: i === 0 && (!oneSession || ci === 0),
      });
      history.push({ role: 'assistant', content: turn.reply });
      ledger.add(...(turn.used ?? []));
    });
  });
  return { steps, changes };
}

function reportCacheEstimate(all: readonly ToolDefinition[]): void {
  const add = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
  const requests = CONVERSATIONS.reduce((n, c) => n + c.turns.length, 0);

  console.log(`\n=== Prompt-cache ESTIMATE over ${CONVERSATIONS.length} scripted conversations (${requests} requests) ===`);
  console.log(`system prompt: ${SYSTEM_PROMPT ? `${SYSTEM_PROMPT.length} B` : 'none'}. "warm" leaves out the`);
  console.log('first request, which both arms pay cold and which the live run primes away.');
  console.log(`${padr('', 40)} ${pad('full', 8)} ${pad('filtered', 8)} ${pad('delta', 8)}  ${pad('warm full', 9)} ${pad('filtered', 8)} ${pad('delta', 8)}`);
  for (const oneSession of [false, true]) {
    const full = cacheSteps(all, CONVERSATIONS, false, oneSession);
    const filt = cacheSteps(all, CONVERSATIONS, true, oneSession);
    const label = oneSession ? 'one session' : 'separate';
    const row = (what: string, a: number[], b: number[]) => {
      const [fa, fb, wa, wb] = [add(a), add(b), add(a.slice(1)), add(b.slice(1))];
      console.log(`${padr(`${label}: ${what}`, 40)} ${pad(fa, 8)} ${pad(fb, 8)} ${pad(`${pct(fb, fa).toFixed(0)}%`, 8)}`
        + `  ${pad(wa, 9)} ${pad(wb, 8)} ${pad(`${pct(wb, wa).toFixed(0)}%`, 8)}`);
    };
    const perStep = (s: CacheStep[]) => s.map((x) => add(x.toolSizes) + x.systemBytes + add(x.messageBytes));
    row('bytes sent (no cache)', perStep(full.steps), perStep(filt.steps));
    for (const m of CACHE_MODELS) row(`prefill, ${m}`, uncachedBytes(full.steps, m), uncachedBytes(filt.steps, m));
    console.log(`${padr(`${label}: tool-list changes`, 40)} ${pad(0, 8)} ${pad(`${filt.changes}/${requests - 1}`, 8)}`);
  }
  console.log('ESTIMATE under a perfect one-request prefix cache. The rows differ in where the');
  console.log('chat template renders the tools (see CacheModel in metrics.ts), and the SIGN');
  console.log('depends on it: tools rendered before the history make every set change a');
  console.log('re-prefill; tools rendered in the last user message are never cached at all.');
  console.log('Run --cache against a real model and template to measure it.');
}

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
  console.log(`${padr('case', 34)} ${pad('tools', 7)} ${pad('bytes', 7)} ${pad('tok', 6)} ${pad('saving', 8)}  wanted  triggers`);
  let sumFull = 0;
  let sumFiltered = 0;
  let worst = { id: '', saving: -Infinity };
  let best = { id: '', saving: Infinity };
  const dropped: string[] = [];

  for (const c of cases) {
    const d = decideFor(all, caseMessages(c), new ToolExposureLedger());
    const b = schemaBytes(d.tools);
    sumFull += fullBytes;
    sumFiltered += b;
    const saving = pct(b, fullBytes);
    if (saving > worst.saving) worst = { id: c.id, saving };
    if (saving < best.saving) best = { id: c.id, saving };
    const trig = d.tools.filter(isInvariantTrigger).map((t) => t.name);
    // Wrong exclusion, measured offline: the tool a correct answer would
    // call is not in the set the model is offered. Costs a hatch round trip
    // at best.
    const kept = !c.wants || d.exposed.has(c.wants);
    if (!kept) dropped.push(c.id);
    console.log(
      `${padr(c.id, 34)} ${pad(`${d.tools.length}/${all.length}`, 7)} ${pad(b, 7)} ${pad(estTokens(b), 6)} `
      + `${pad(`${saving.toFixed(1)}%`, 8)}  ${padr(kept ? 'kept' : 'DROPPED', 7)} ${trig.length ? trig.join(',') : '-'}`,
    );
  }

  console.log(`\naggregate over ${cases.length} cases: ${sumFiltered} / ${sumFull} B `
    + `= ${pct(sumFiltered, sumFull).toFixed(1)}%`);
  console.log(`best case:  ${best.id} ${best.saving.toFixed(1)}%`);
  console.log(`worst case: ${worst.id} ${worst.saving.toFixed(1)}%`);
  console.log(`wanted tool dropped: ${dropped.length}/${cases.length}${dropped.length ? ` (${dropped.join(', ')})` : ''}`);
  console.log(`invariant violations: ${invariantViolationCount()} (must be 0 to ship)`);

  reportCacheEstimate(all);
}

// ------------------------------------------------------------------ backend

/** A provider-neutral turn in the conversation the harness sends. */
type WireMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; call: ToolCallOut }
  | { role: 'tool'; content: string; callId: string };

let callsMade = 0;

/** The harness only ever builds plain-text system/user/assistant messages. */
function toWire(messages: readonly LLMMessage[]): WireMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool' || typeof m.content !== 'string') {
      throw new Error(`toWire: unexpected ${m.role} message; the harness builds text turns only`);
    }
    return { role: m.role, content: m.content };
  });
}

async function post(url: string, body: unknown): Promise<unknown> {
  if (callsMade >= MAX_CALLS) throw new Error(`--max-calls ${MAX_CALLS} reached`);
  callsMade += 1;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (API_KEY_ENV) {
    const key = process.env[API_KEY_ENV];
    if (!key) throw new Error(`--api-key-env ${API_KEY_ENV} is not set`);
    headers.authorization = `Bearer ${key}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    // Bun's fetch times out at 5 minutes by default. A cold full-tool-set
    // prefill on a 27B local model measured 646 s here, so the default
    // silently turns "slow but working" into "the benchmark cannot run".
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * `prefillOnly` for the cache run: only the prompt is being measured, so
 * generating one token instead of up to 512 cuts most of a CPU run's time.
 */
async function askOllama(model: string, tools: readonly ToolDefinition[], messages: WireMessage[], prefillOnly: boolean): Promise<Reply> {
  const body = await post(`${BASE_URL}/api/chat`, {
    model,
    stream: false,
    messages: messages.map((m) => {
      if ('call' in m) return { role: 'assistant', content: m.content, tool_calls: [{ function: { name: m.call.name, arguments: m.call.args } }] };
      if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.callId };
      return { role: m.role, content: m.content };
    }),
    tools: tools.map((t) => ({ type: 'function', function: wireTool(t) })),
    options: {
      // Greedy, so the two arms differ only in the tool list.
      temperature: 0,
      seed: 7,
      // --cpu forces CPU offload, for a box whose GPU cannot hold the model.
      ...(FORCE_CPU ? { num_gpu: 0 } : {}),
      // --num-ctx matters more than it looks. These models advertise a
      // 262144 context, and ollama sizes the KV cache for it: ~4.5 GB
      // before a single token is processed, which is enough to fail
      // allocation on both GPU and CPU on the reference box. The whole
      // measurement fits in 16k.
      ...(NUM_CTX ? { num_ctx: NUM_CTX } : {}),
      ...(prefillOnly ? { num_predict: 1 } : {}),
    },
  });
  return parseOllamaReply(body as Parameters<typeof parseOllamaReply>[0], `c${callsMade}`);
}

async function askOpenAI(model: string, tools: readonly ToolDefinition[], messages: WireMessage[], prefillOnly: boolean): Promise<Reply> {
  const body = await post(`${BASE_URL}/chat/completions`, {
    model,
    stream: false,
    temperature: 0,
    seed: 7,
    // Generous: a reasoning model cut off before its tool call scores as
    // "no call", and the verdict then reports NO RESULT rather than a pass.
    max_tokens: prefillOnly ? 1 : 2048,
    messages: messages.map((m) => {
      if ('call' in m) {
        return {
          role: 'assistant', content: m.content || null,
          tool_calls: [{ id: m.call.id, type: 'function', function: { name: m.call.name, arguments: JSON.stringify(m.call.args) } }],
        };
      }
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.callId, content: m.content };
      return { role: m.role, content: m.content };
    }),
    tools: tools.map((t) => ({ type: 'function', function: wireTool(t) })),
    tool_choice: 'auto',
    // llama-server: keep the KV cache between requests, which is the
    // behaviour --cache measures. Ignored by servers that do not know it.
    cache_prompt: true,
  });
  return parseOpenAIReply(body as Parameters<typeof parseOpenAIReply>[0], `c${callsMade}`);
}

function modelId(): string {
  return MODEL_REF!.split(':').slice(1).join(':') || MODEL_REF!;
}

function ask(tools: readonly ToolDefinition[], messages: WireMessage[], prefillOnly = false): Promise<Reply> {
  return API === 'openai'
    ? askOpenAI(modelId(), tools, messages, prefillOnly)
    : askOllama(modelId(), tools, messages, prefillOnly);
}

function requireModel(): void {
  if (!MODEL_REF) {
    console.error('live modes need --model <provider:model>, e.g. --model ollama:qwen2.5:7b');
    console.error('The configured tier map is deliberately NOT used: its models are usually');
    console.error('frontier ones, which the eligibility gate correctly refuses to filter.');
    process.exit(2);
  }
  if (API !== 'ollama' && API !== 'openai') {
    console.error(`--api must be ollama or openai, not "${API}"`);
    process.exit(2);
  }
}

// ---------------------------------------------------------- accuracy report

/**
 * The filtered arm of one case, escape hatch included.
 *
 * Two things the loops answer without dispatching are answered here the
 * same way, and the model asked again:
 *
 *   - a `discover_tools` call (`handleDiscoverTools`, then a fresh decision
 *     over the grown ledger);
 *   - a call to a tool it was not offered that `interceptOffList` refuses
 *     -- an unframed fetch while a framed reader was hidden. The Tool Guide
 *     in the system prompt names every tool, so this is a real path.
 *
 * What gets scored is the tool it finally commits to. Scoring the first call
 * would count "asked for the browser, then got it and used it" as a miss,
 * and -- worse -- would never see "asked for the catalogue, then picked the
 * shell", or "was refused the hidden shell, then called it again".
 */
async function filteredArm(all: readonly ToolDefinition[], c: BenchCase) {
  const ledger = new ToolExposureLedger();
  const base = caseMessages(c);
  // What selection reads, as the loops build it: the case, plus any
  // assistant text the model produced alongside its calls.
  const selectionInput: LLMMessage[] = [...base];
  let d = decideFor(all, selectionInput, ledger);
  const offeredBytes = schemaBytes(d.tools);
  const wire = toWire(base);
  let reply = await ask(d.tools, wire);
  const first = reply;
  let hatchRounds = 0;
  let offListCalls = 0;
  let multiCall = reply.callCount > 1;
  // True when the last call is one production would NOT run, so it is not
  // the model's committed answer.
  let uncommitted = false;
  while (reply.call) {
    let result: string;
    if (reply.call.name === DISCOVER_TOOLS) {
      if (hatchRounds >= MAX_HATCH_ROUNDS) { uncommitted = true; break; }
      result = handleDiscoverTools(reply.call.args, all, ledger, d.exposed).result;
    } else {
      // Dry-run first on a copy, so a call past the round limit is judged
      // without widening the real ledger.
      const probe = new ToolExposureLedger();
      probe.add(...ledger.snapshot());
      const would = interceptOffList(reply.call.name, { all, ledger: probe, exposed: d.exposed, filterEnabled: true });
      if (!would?.refusal) {
        if (would) { offListCalls += 1; ledger.add(reply.call.name); }
        break; // dispatched in production: this is the answer
      }
      offListCalls += 1;
      if (hatchRounds >= MAX_HATCH_ROUNDS) { uncommitted = true; break; }
      result = interceptOffList(reply.call.name, { all, ledger, exposed: d.exposed, filterEnabled: true })!.refusal!;
    }
    hatchRounds += 1;
    wire.push({ role: 'assistant', content: reply.content, call: reply.call });
    wire.push({ role: 'tool', content: result, callId: reply.call.id });
    if (reply.content) selectionInput.push({ role: 'assistant', content: reply.content });
    d = decideFor(all, selectionInput, ledger);
    reply = await ask(d.tools, wire);
    multiCall ||= reply.callCount > 1;
  }
  const final: string | null = uncommitted ? null : (reply.call?.name ?? null);
  return { first, final, hatchRounds, offListCalls, offeredBytes, multiCall, uncommitted };
}

async function reportAccuracy(all: ToolDefinition[]): Promise<boolean> {
  const cases = selectedCases(all);
  if (cases.length === 0) {
    console.error(`no cases matched --case "${CASE_MATCH}"`);
    process.exit(2);
  }

  console.log(`\n=== Tool selection accuracy: ${modelId()} via ${API} ${BASE_URL} ===`);
  console.log(`${cases.length} cases x 2 arms (+ up to ${MAX_HATCH_ROUNDS} hatch rounds each); system prompt `
    + `${SYSTEM_PROMPT ? `${SYSTEM_PROMPT.length} B` : 'none'}.\n`);

  const score = {
    fullCorrect: 0, filteredCorrect: 0,
    fullNoCall: 0, filteredNoCall: 0,
    substitutions: 0, framedCases: 0,
    fullUnframedOnFramed: 0, filteredUnframedOnFramed: 0,
    hatchCases: 0, hatchRecovered: 0, offListCases: 0, multiCallCases: 0, uncommittedCases: 0, errors: 0,
    framedFullFramed: 0, scored: 0,
    fullSent: 0, filteredSent: 0, sentKnown: true,
  };
  const pairs: Array<{ full: boolean; filtered: boolean }> = [];

  for (const c of cases) {
    try {
      const full = await ask(all, toWire(caseMessages(c)));
      const f = await filteredArm(all, c);
      const fullName = full.call?.name ?? null;
      const finalName = f.final;

      // Tokens SENT, from the server's own total. Evaluated counts would be
      // post-cache (the arms share a server), and ollama reports no total.
      if (full.promptTokens === null || f.first.promptTokens === null) score.sentKnown = false;
      score.fullSent += full.promptTokens ?? 0;
      score.filteredSent += f.first.promptTokens ?? 0;
      if (f.multiCall) score.multiCallCases += 1;
      if (f.uncommitted) score.uncommittedCases += 1;
      if (fullName === null) score.fullNoCall += 1;
      if (finalName === null) score.filteredNoCall += 1;
      if (c.wants) {
        score.scored += 1;
        const fullOk = fullName === c.wants;
        const filtOk = finalName === c.wants;
        if (fullOk) score.fullCorrect += 1;
        if (filtOk) score.filteredCorrect += 1;
        pairs.push({ full: fullOk, filtered: filtOk });
      }
      if (f.offListCalls > 0) score.offListCases += 1;
      if (f.hatchRounds > 0) {
        score.hatchCases += 1;
        if (c.wants && finalName === c.wants) score.hatchRecovered += 1;
      }

      // The metric that decides whether this ships: did filtering push the
      // model off a framed read and onto an unframed fetch tool?
      let substituted = false;
      if (c.wantsFramedRead) {
        score.framedCases += 1;
        const fullTool = all.find((t) => t.name === fullName);
        if (fullTool && outsideReach(fullTool) === 'framed') score.framedFullFramed += 1;
        if (isUnframedFetch(fullName, all)) score.fullUnframedOnFramed += 1;
        if (isUnframedFetch(finalName, all)) score.filteredUnframedOnFramed += 1;
        substituted = isFilterSubstitution(fullName, finalName, all);
        if (substituted) score.substitutions += 1;
      }

      console.log(
        `${padr(c.id, 34)} full=${padr(fullName ?? '-', 20)} filtered=${padr(finalName ?? '-', 20)}`
        + `${f.hatchRounds ? ` (hatch x${f.hatchRounds})` : ''}${f.offListCalls ? ' (off-list)' : ''}`
        + `${f.uncommitted ? ' (uncommitted)' : ''}${f.multiCall ? ' (multi-call)' : ''}`
        + ` ${pad(full.promptTokens ?? 'n/a', 6)}->${pad(f.first.promptTokens ?? 'n/a', 6)} tok sent`
        + (substituted ? '  *** SUBSTITUTION ***' : ''),
      );
    } catch (err) {
      score.errors += 1;
      console.log(`${padr(c.id, 34)} ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const n = cases.length - score.errors;
  const acc = accuracyVerdict(pairs);
  console.log(`\n--- accuracy over ${n} cases (${score.errors} errored) ---`);
  console.log(`correct tool:      full ${score.fullCorrect}/${n}   filtered ${score.filteredCorrect}/${n}`);
  console.log(`discordant pairs:  full-only ${acc.b}   filtered-only ${acc.c}   McNemar exact p=${acc.p.toFixed(3)}`);
  console.log(`no tool called:    full ${score.fullNoCall}/${n}   filtered ${score.filteredNoCall}/${n}`);
  console.log(score.sentKnown
    ? `prompt tokens sent: full ${score.fullSent}   filtered ${score.filteredSent}`
      + `   (${pct(score.filteredSent, score.fullSent).toFixed(1)}%, first call of each arm, cache NOT accounted)`
    : 'prompt tokens sent: n/a (this server reports no prompt total; see --cache for evaluated tokens)');
  console.log(`escape hatch:      used on ${score.hatchCases} cases, recovered the wanted tool on ${score.hatchRecovered}`);
  console.log(`off-list calls:    on ${score.offListCases} cases the model called a tool it was not offered`);
  console.log(`uncommitted:       ${score.uncommittedCases} cases ended on a call production would not run (scored as no call)`);
  console.log(`multi-call:        ${score.multiCallCases} cases replied with several calls; only the first was followed`);
  console.log(`unframed fetch on framed-read cases: full ${score.fullUnframedOnFramed}   filtered ${score.filteredUnframedOnFramed}`);
  console.log(`SUBSTITUTIONS:     ${score.substitutions} over ${score.framedCases} framed-read cases`);
  console.log(`invariant violations: ${invariantViolationCount()}`);
  console.log('');

  // A run that measured nothing must never read as a pass; see
  // accuracyRunVerdict for every guard and why each exists.
  const v = accuracyRunVerdict({
    cases: cases.length, errors: score.errors, scored: score.scored, fullCorrect: score.fullCorrect,
    framedCases: score.framedCases, framedFullFramed: score.framedFullFramed,
    substitutions: score.substitutions, violations: invariantViolationCount(), accuracy: acc,
  });
  for (const line of v.lines) console.log(line);
  return v.pass;
}

// ------------------------------------------------------------- cache report

/**
 * The cache-accounted saving, measured.
 *
 * Each arm replays every scripted conversation in order against the same
 * server, so whatever the server caches between requests is exactly what it
 * would cache in production. One priming request per arm is sent first and
 * not counted, so neither arm is charged for the other's leftover KV state.
 * The number that matters is the sum of EVALUATED prompt tokens: what the
 * server actually had to prefill.
 */
async function reportCache(all: ToolDefinition[]): Promise<boolean> {
  const turns = CONVERSATIONS.reduce((n, c) => n + c.turns.length, 0);
  console.log(`\n=== Prompt-cache accounting: ${modelId()} via ${API} ${BASE_URL} ===`);
  console.log(`${CONVERSATIONS.length} conversations, ${turns} requests per arm, 2 arms, +1 priming request each; `
    + `${ONE_SESSION ? 'one session (one ledger and history across all)' : 'separate conversations'}.`);
  console.log('Measures ONE server and ONE chat template: the sign of the result depends on where the template');
  console.log('renders tools (see the offline estimate). Record both next to the verdict.\n');

  const totals: Record<'full' | 'filtered', { evaluated: number; prompt: number; ms: number; unknown: number }> = {
    full: { evaluated: 0, prompt: 0, ms: 0, unknown: 0 },
    filtered: { evaluated: 0, prompt: 0, ms: 0, unknown: 0 },
  };
  try {
    for (const arm of ['full', 'filtered'] as const) {
      let primed = false;
      let ledger = new ToolExposureLedger();
      let history: LLMMessage[] = [];
      for (const conv of CONVERSATIONS) {
        if (!ONE_SESSION) {
          ledger = new ToolExposureLedger();
          history = [];
        }
        for (const turn of conv.turns) {
          history.push({ role: 'user', content: turn.user });
          const messages = [...systemMessages(), ...history];
          const tools = arm === 'full' ? all : decideFor(all, messages, ledger).tools;
          if (!primed) { await ask(tools, toWire(messages), true); primed = true; }
          const r = await ask(tools, toWire(messages), true);
          const t = totals[arm];
          if (r.evaluatedTokens === null) t.unknown += 1; else t.evaluated += r.evaluatedTokens;
          t.prompt += r.promptTokens ?? 0;
          t.ms += r.prefillMs ?? 0;
          console.log(`${padr(arm, 9)} ${padr(conv.id, 22)} ${pad(tools.length, 3)} tools  evaluated ${pad(r.evaluatedTokens ?? '?', 6)}`
            + `${r.promptTokens !== null ? ` of ${pad(r.promptTokens, 6)}` : ''}`);
          history.push({ role: 'assistant', content: turn.reply });
          ledger.add(...(turn.used ?? []));
        }
      }
    }
  } catch (err) {
    console.log(`\nERROR ${err instanceof Error ? err.message : String(err)}`);
    console.log('NO CACHE RESULT: the run did not finish, so the criterion is unproven.');
    return false;
  }

  const { full, filtered } = totals;
  console.log(`\nevaluated prompt tokens: full ${full.evaluated}   filtered ${filtered.evaluated}`
    + `   (${pct(filtered.evaluated, full.evaluated).toFixed(1)}%)`);
  if (full.prompt > 0) console.log(`prompt tokens sent:      full ${full.prompt}   filtered ${filtered.prompt}`);
  if (full.ms > 0) console.log(`prefill ms:              full ${full.ms}   filtered ${filtered.ms}`);
  if (full.unknown + filtered.unknown > 0) {
    console.log(`NO CACHE RESULT: the server did not report evaluated tokens on ${full.unknown + filtered.unknown} requests.`);
    console.log('Use ollama, or llama-server (reports `timings.prompt_n`), or an endpoint that returns');
    console.log('usage.prompt_tokens_details.cached_tokens.');
    return false;
  }
  const ok = filtered.evaluated < full.evaluated;
  console.log(`criterion 3, saving survives cache accounting: ${ok ? 'MET' : 'NOT MET'}`);
  return ok;
}

// ---------------------------------------------------------------------- run

const { tools, skipped } = await buildProductionRegistry();
resetInvariantViolationCount();
if (MODE_ACCURACY || MODE_CACHE) {
  requireModel();
  if (skipped.length > 0) {
    console.error(`refusing a live run over an incomplete registry: ${skipped.join('; ')}`);
    process.exit(2);
  }
  // full + first filtered + one per hatch round + the committing call.
  const perCase = 3 + MAX_HATCH_ROUNDS;
  const planned = (MODE_ACCURACY ? selectedCases(tools).length * perCase : 0)
    + (MODE_CACHE ? 2 * (1 + CONVERSATIONS.reduce((n, c) => n + c.turns.length, 0)) : 0);
  console.log(`planned provider calls: at most ${planned} (--max-calls ${MAX_CALLS})`);
  if (planned > MAX_CALLS) {
    console.error(`refusing to start: the plan exceeds --max-calls. Narrow it with --limit/--case/--issue-only or raise the cap.`);
    process.exit(2);
  }
  let pass = true;
  if (MODE_ACCURACY) pass = (await reportAccuracy(tools)) && pass;
  if (MODE_CACHE) pass = (await reportCache(tools)) && pass;
  console.log(`\nprovider calls made: ${callsMade}`);
  if (MODE_LIVE) {
    if (!pass) console.log('EXIT CRITERIA NOT MET OR UNPROVEN. The default stays off.');
    else if (SUBSET) console.log('SUBSET RUN: criteria met on the cases selected, which is a smoke test, not a flip decision.');
    else console.log('ALL THREE EXIT CRITERIA MET on this model and template. See docs section 10 before flipping anything.');
  }
  if (!pass) process.exitCode = 1;
} else {
  await reportTokens(tools, skipped);
}
