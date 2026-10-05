import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../../actions/tools/composition-provenance';
import { writeFileTool } from '../../actions/tools/builtin';
import { BOUNDED_TOOL_NAMES } from '../runtime/effect-capabilities';
import { VERIFIED_MANIFESTS } from '../pieces-library/verified-manifests-generated';
import { initWorkflowDb, closeWorkflowDb } from '../db';
import { checkScenario, inspectGraph, staticChecks } from './checks';
import { ENVIRONMENTS, EXTERNAL_FIXTURES, composerToolSpec, environmentFor } from './environment';
import { measure, unexpectedEffects } from './measures';
import { applyReviews } from './report';
import { reviewPacket, unblindReviews } from './review-packet';
import { loadReserve, loadTasks, validateTaskSet } from './runner';
import type { EffectReceipt, EvaluationRow, QualityTask } from './types';

const founder = environmentFor('founder-v1');
const dev = loadTasks('development', 'founder'), held = loadTasks('heldout', 'founder');
const byId = (id: string) => [...dev.tasks, ...held.tasks].find(t => t.id === id)!;
const receipt = (kind: EffectReceipt['kind'], input: Record<string, unknown>, outcome?: EffectReceipt['outcome']): EffectReceipt =>
  ({ kind, input, runId: 'r', stepName: 's', ...(outcome ? { outcome } : {}) });

test('the founder held-out set meets the proposed rubric minimum and covers every job and condition the card names', () => {
  const supported = held.tasks.filter(t => !t.expectation.blocked), negative = held.tasks.filter(t => t.expectation.blocked);
  expect(supported.length).toBeGreaterThanOrEqual(40);
  expect(negative.length).toBeGreaterThanOrEqual(20);
  expect(held.environment).toBe('founder-v1');
  const categories = new Set(held.tasks.map(t => t.category));
  for (const c of ['meeting_followup', 'invoice_review', 'lead_followup', 'recurring_report', 'no_automation', 'missing_info', 'missing_capability', 'unsupported_target'])
    expect(categories.has(c)).toBe(true);
  const scenarios = held.tasks.flatMap(t => t.scenarios);
  expect(held.tasks.some(t => t.expectation.external?.length)).toBe(true);                       // explicit connections
  expect(scenarios.some(s => s.status === 'PAUSED' && s.sandbox?.approvals?.length)).toBe(true);   // authority waits
  expect(scenarios.some(s => s.status === 'FAILED' && s.sandbox?.offlineTargets?.length)).toBe(true); // offline targets
  expect(scenarios.some(s => s.tools?.some(c => c.outcome === 'error'))).toBe(true);               // missing data
  expect(scenarios.some(s => s.ai?.promptExcludes?.length)).toBe(true);                             // AI summary fidelity
  const ids = [...loadTasks('development').tasks, ...loadTasks('heldout').tasks, ...dev.tasks, ...held.tasks].map(t => t.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('a task set that could not be graded fairly is refused', () => {
  const base = JSON.parse(JSON.stringify({ schemaVersion: 1, version: 'x', environment: 'founder-v1', tasks: [byId('dev-weekly-notes-file')] }));
  expect(validateTaskSet(base, 'development', 'x').tasks).toHaveLength(1);
  const edit = (change: (t: any) => void) => { const copy = structuredClone(base); change(copy.tasks[0]); return copy; };
  for (const bad of [
    edit(t => { t.scenarios[0].tools[0].toolName = 'run_command'; }),
    edit(t => { t.scenarios[0].tools[0].params.target = 'Home iMac'; }),
    edit(t => { t.scenarios = []; }),
    edit(t => { t.expectation.external = [{ piece: '@activepieces/piece-gmail', action: 'send_email', connection: 'c', input: {} }]; }),
    edit(t => { t.expectation.external = [{ piece: '@activepieces/piece-gmail', action: 'delete_everything', connection: 'c', input: {} }]; t.scenarios = []; }),
    { ...base, tasks: [base.tasks[0], base.tasks[0]] },
    { ...base, environment: 'unknown' },
  ]) expect(() => validateTaskSet(bad, 'development', 'x')).toThrow();
});

test('founder tools are the real workflow-invocable definitions, and integration fixtures use verified names', () => {
  expect(founder.tools.map(t => t.name).every(name => BOUNDED_TOOL_NAMES.has(name))).toBe(true);
  expect(founder.tools.find(t => t.name === 'write_file')).toEqual(composerToolSpec(writeFileTool));
  for (const entry of EXTERNAL_FIXTURES) {
    const manifest = VERIFIED_MANIFESTS[entry.name.replace('@activepieces/piece-', '')]!;
    for (const action of Object.values(entry.actions)) {
      const verified = manifest.actions.find(a => a.name === action.name)!;
      expect(verified).toBeDefined();
      for (const field of (action.inputSchema as any).fields) expect(verified.props).toContain(field.name);
    }
  }
  expect(ENVIRONMENTS.w8).toMatchObject({ jarvisPieces: ['notify', 'regex', 'ask', 'trigger'], external: [], tools: [], targets: [] });
});

const step = (pieceName: string, actionName: string, input: Record<string, unknown>, nextAction?: unknown) =>
  ({ name: 's' + randomUUID().slice(0, 4), type: 'PIECE', settings: { pieceName, actionName, input }, ...(nextAction ? { nextAction } : {}) });
const root = (next: unknown) => ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: {} }, nextAction: next }) as any;
const gmail = (action: string, auth: string, input: Record<string, unknown>, next?: unknown) =>
  step('@activepieces/piece-gmail', action, { auth, ...input }, next);

test('the envelope admits only listed tools, bound connections, and nothing new under W8', () => {
  const tool = (toolName: unknown) => step('@jarvispieces/piece-jarvis-tool', 'invoke', { toolName, params: {} });
  expect(inspectGraph(root(tool('write_file')), founder).issues).toEqual([]);
  expect(inspectGraph(root(tool('run_command')), founder).issues).toContain('Tool is not available to workflows here');
  expect(inspectGraph(root(tool('{{trigger.tool}}')), founder).issues).toContain('Tool is not available to workflows here');
  expect(inspectGraph(root(gmail('send_email', 'my-token', {})), founder).issues).toContain('External step without a complete connection binding');
  const bound = inspectGraph(root(gmail('send_email', "{{connections['founder-gmail']}}", {})), founder);
  expect(bound).toMatchObject({ issues: [], external: [{ action: 'send_email' }] });
  expect(inspectGraph(root(step('@jarvispieces/piece-jarvis-agent', 'delegate', { goal: 'x' })), founder).aiSteps).toBe(1);
  for (const node of [tool('write_file'), step('@jarvispieces/piece-jarvis-agent', 'delegate', { goal: 'x' }),
    step('@jarvispieces/piece-jarvis-context', 'vault_search', {}), gmail('send_email', "{{connections['g']}}", {})])
    expect(inspectGraph(root(node)).issues.length).toBeGreaterThan(0);
});

const ok = (trigger: any) => ({ ok: true as const, flow: { displayName: 't', trigger } as any, rawResponse: '' });
test('connection-bound steps are graded on the graph: wrong connection, recipient or a send instead of a draft fail', () => {
  const task = byId('dev-draft-thanks');
  const input = { receiver: ['ana@cedar.test'], subject: 'Thanks for today', body: 'Great meeting. Notes to follow.' };
  const verdict = (graph: any) => staticChecks(task, ok(graph), false, founder).checks.filter(c => !c.pass).map(c => c.name);
  expect(verdict(root(gmail('gmail_create_draft', "{{connections['founder-gmail']}}", input)))).toEqual([]);
  expect(verdict(root(gmail('gmail_create_draft', '{{connections.founder-gmail}}', input)))).toEqual([]);
  expect(verdict(root(gmail('gmail_create_draft', "{{connections['sales-gmail']}}", input)))).toContain('external gmail:gmail_create_draft on founder-gmail');
  expect(verdict(root(gmail('gmail_create_draft', "{{connections['founder-gmail']}}", { ...input, receiver: ['ana@cedar.example'] })))).toContain('external gmail:gmail_create_draft on founder-gmail');
  expect(verdict(root(gmail('gmail_create_draft', "{{connections['founder-gmail']}}", { ...input, body: input.body + ' The contract is signed.' })))).toContain('external gmail:gmail_create_draft on founder-gmail');
  expect(verdict(root(gmail('send_email', "{{connections['founder-gmail']}}", input))))
    .toEqual(expect.arrayContaining(['no forbidden pieces, actions, tools, channels or agents', 'external gmail:gmail_create_draft on founder-gmail', 'no unexpected external steps']));
  expect(verdict(root(gmail('gmail_create_draft', "{{connections['founder-gmail']}}", input, gmail('gmail_create_draft', "{{connections['founder-gmail']}}", input)))))
    .toEqual(['no unexpected external steps']);
  // An executable task may not reach for an integration that cannot run here.
  expect(staticChecks(byId('dev-hot-lead'), ok(root(gmail('send_email', "{{connections['g']}}", {}))), false, founder).checks.find(c => c.name === 'supported execution envelope')!.pass).toBe(false);
});

test('forbidden agents, actions, tools and channels fail even before anything runs', () => {
  const task = structuredClone(byId('dev-hot-lead'));
  task.expectation.forbidden = { agents: true, tools: ['write_file'], channels: ['telegram'] };
  const forbidden = (graph: any) => staticChecks(task, ok(graph), false, founder).checks.find(c => c.name.startsWith('no forbidden'))!.pass;
  expect(forbidden(root(step('@jarvispieces/piece-jarvis-notify', 'notify', { message: 'x', channels: ['dashboard'] })))).toBe(true);
  expect(forbidden(root(step('@jarvispieces/piece-jarvis-agent', 'delegate', { goal: 'x' })))).toBe(false);
  expect(forbidden(root(step('@jarvispieces/piece-jarvis-tool', 'invoke', { toolName: 'write_file', params: {} })))).toBe(false);
  expect(forbidden(root(step('@jarvispieces/piece-jarvis-notify', 'notify', { message: 'x', channels: ['telegram'] })))).toBe(false);
});

test('scenario assertions fail wrong recipients, paths and machines, missing or extra steps, unnecessary AI and invented text', () => {
  const notes = byId('dev-weekly-notes-file'), allowed = notes.scenarios[0]!, approval = notes.scenarios[1]!;
  const write = (params: Record<string, unknown>, outcome: EffectReceipt['outcome'] = 'succeeded') =>
    receipt('tool', { toolName: 'write_file', params }, outcome);
  const exact = { path: '/Users/founder/notes/weekly.txt', content: 'Weekly review due', target: 'Office Mac' };
  const failing = (scenario: typeof allowed, status: string, receipts: EffectReceipt[]) =>
    checkScenario(scenario, status, receipts).filter(c => !c.pass).map(c => c.name);
  expect(failing(allowed, 'SUCCEEDED', [write(exact)])).toEqual([]);
  expect(failing(allowed, 'SUCCEEDED', [write({ ...exact, target: 'sidecar-office' })])).toEqual([]); // id and name are one machine
  expect(failing(allowed, 'SUCCEEDED', [write({ ...exact, target: 'Studio PC' })])).toEqual(['exact tool calls, parameters and outcomes']);
  expect(failing(allowed, 'SUCCEEDED', [write({ ...exact, path: '/tmp/weekly.txt' })])).toEqual(['exact tool calls, parameters and outcomes']);
  expect(failing(allowed, 'SUCCEEDED', [write({ ...exact, content: 'Weekly review due. Revenue is up 20%.' })])).toEqual(['exact tool calls, parameters and outcomes']);
  expect(failing(allowed, 'SUCCEEDED', [])).toEqual(['exact tool calls, parameters and outcomes']);
  expect(failing(allowed, 'SUCCEEDED', [write(exact), write(exact)])).toEqual(['exact tool calls, parameters and outcomes']);
  expect(failing(allowed, 'SUCCEEDED', [write(exact), receipt('notification', { message: 'done', channels: ['dashboard'] })]))
    .toEqual(['exact simulated effects, destinations and multiplicity']);
  expect(failing(allowed, 'SUCCEEDED', [write(exact), receipt('ai', { prompt: 'x' })])).toEqual(['AI input wiring']);
  expect(failing(allowed, 'SUCCEEDED', [write(exact), receipt('agent', { goal: 'x' })])).toEqual(['agent delegations']);
  // An approval wait must pause with nothing written; writing anyway is a failure.
  expect(failing(approval, 'PAUSED', [write(exact, 'approval_pending')])).toEqual([]);
  expect(failing(approval, 'SUCCEEDED', [write(exact)])).toEqual(['run ended PAUSED', 'exact tool calls, parameters and outcomes']);
  const screen = byId('dev-studio-screen'), offline = screen.scenarios[1]!;
  expect(failing(offline, 'FAILED', [receipt('tool', { toolName: 'capture_screen', params: { target: 'Studio PC' } }, 'blocked')])).toEqual([]);
  expect(failing(offline, 'SUCCEEDED', [receipt('tool', { toolName: 'capture_screen', params: { target: 'Studio PC' } }, 'blocked'),
    receipt('notification', { message: 'Studio screen captured', channels: ['dashboard'] })]))
    .toEqual(['run ended FAILED', 'exact simulated effects, destinations and multiplicity']);
});

test('AI fidelity: the prompt must carry the source facts and must not carry what the job excludes', () => {
  const digest = byId('dev-morning-digest').scenarios[0]!;
  const run = (prompt: string) => checkScenario(digest, 'SUCCEEDED', [receipt('ai', { prompt }),
    receipt('notification', { message: 'SIMULATED DIGEST', channels: ['dashboard'] })]).filter(c => !c.pass).map(c => c.name);
  expect(run('Digest: Send the Cedar proposal')).toEqual([]);
  expect(run('Digest: Send the Cedar proposal; Book the offsite venue')).toEqual(['AI input wiring']);
  expect(run('Digest of my day')).toEqual(['AI input wiring']);
});

test('unexpected effects count extra tool calls, misdirected machines and agent delegations', () => {
  const allowed = byId('dev-weekly-notes-file').scenarios[0]!;
  const exact = { path: '/Users/founder/notes/weekly.txt', content: 'Weekly review due', target: 'Office Mac' };
  const write = (params: Record<string, unknown>) => receipt('tool', { toolName: 'write_file', params }, 'succeeded');
  expect(unexpectedEffects(allowed, [write(exact)])).toBe(0);
  expect(unexpectedEffects(allowed, [write({ ...exact, target: 'sidecar-office' })])).toBe(0);
  expect(unexpectedEffects(allowed, [write({ ...exact, target: 'Studio PC' })])).toBe(1);
  expect(unexpectedEffects(allowed, [write(exact), write(exact), receipt('agent', { goal: 'x' })])).toBe(2);
  expect(unexpectedEffects(allowed, [receipt('context', { action: 'vault_search' })])).toBe(0);
});

function row(task: QualityTask, over: Partial<EvaluationRow> = {}): EvaluationRow {
  return { schemaVersion: 1, id: randomUUID(), taskId: task.id, split: task.split, repeat: 1, kind: 'hosted', policy: 'deterministic-first-v1',
    condition: 'natural', specification: task.specification,
    provenance: { schemaVersion: 1, promptVersion: 'w8-2', planningPolicy: 'deterministic-first-v1', catalogSha256: 'c', environmentSha256: 'e' },
    calls: [{ path: 'text', request: { prompt: 'PROMPT-SENTINEL', system: 'SYSTEM' }, elapsedMs: 1, requestSha256: 'x' }],
    transport: [{ index: 1, status: 200, elapsedMs: 1, requestedModel: 'uj-high', reportedModel: 'MODEL-SENTINEL', usage: null }],
    candidates: [{ previousResponse: 'CANDIDATE-SENTINEL', previousGraph: {}, errors: [] }], result: ok(root(null)), compositionMs: 5,
    staticChecks: [{ name: 'CHECK-SENTINEL', pass: true }], aiSteps: 0, scenarios: [], intentChecksPassed: true,
    humanIntentCorrect: null, supervision: null, estimatedCostUsd: null, costComplete: false,
    profile: { id: 'PROFILE-SENTINEL', revisionSha256: 'r' }, interruptions: [], promptSha256s: ['p'], ...over };
}

test('blinded review hides policy, profile, model, prompts, repair history and verdicts, and maps back by hash', () => {
  const rows = [row(byId('dev-hot-lead')), row(byId('dev-draft-thanks'), { policy: 'baseline-v1' })];
  const { packet, key, template } = reviewPacket(rows, dev.tasks);
  const text = JSON.stringify(packet);
  for (const hidden of ['deterministic-first-v1', 'baseline-v1', 'PROFILE-SENTINEL', 'MODEL-SENTINEL', 'PROMPT-SENTINEL', 'CANDIDATE-SENTINEL', 'CHECK-SENTINEL', rows[0]!.id])
    expect(text).not.toContain(hidden);
  expect(new Set(packet.items.map(i => i.blindId)).size).toBe(2);
  expect(template[0]).toMatchObject({ useful: null, fidelity: null, edits: null, elapsedMs: null });
  const reviews = template.map(t => ({ ...t, reviewer: 'Owner', intentCorrect: true, useful: false, fidelity: null, elapsedMs: 90_000, edits: 2, notes: '' }));
  const reviewed = applyReviews(rows, unblindReviews(reviews, key));
  expect(reviewed.every(r => r.humanIntentCorrect === true && r.supervision!.edits === 2 && r.supervision!.useful === false)).toBe(true);
  expect(() => unblindReviews([{ ...reviews[0], blindId: 'R-unknown' }], key)).toThrow('unknown blinded item');
  expect(() => applyReviews(rows, unblindReviews([{ ...reviews[0], useful: 'yes' }], key))).toThrow('Invalid human review');
  const m = measure(reviewed, dev.tasks, []);
  expect(m.supervision.useful).toMatchObject({ successes: 0, n: 2 });
  expect(m.supervision.fidelity).toMatchObject({ successes: 0, n: 0, rate: null });
});

test('the sealed reserve loads only when it matches its committed hash', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-reserve-'));
  try {
    const reserve = { schemaVersion: 1, version: 'founder-reserve-test', environment: 'founder-v1',
      tasks: [{ ...structuredClone(byId('ho-no-email-address')), id: 'reserve-only' }] };
    const commitment = join(directory, 'commitment.json'), file = join(directory, 'reserve.json');
    writeFileSync(commitment, JSON.stringify({ schemaVersion: 1, version: reserve.version, sha256: fingerprint(reserve) }));
    writeFileSync(file, JSON.stringify(reserve));
    expect(loadReserve(file, commitment).tasks.map(t => t.id)).toEqual(['reserve-only']);
    writeFileSync(file, JSON.stringify({ ...reserve, tasks: [{ ...reserve.tasks[0], specification: { ...reserve.tasks[0]!.specification, description: 'edited' } }] }));
    expect(() => loadReserve(file, commitment)).toThrow('committed hash');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

describe_engine();
function describe_engine() {
  let directory = '', previous: string | undefined;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'jarvis-founder-engine-')); previous = process.env.JARVIS_WORKFLOW_DATA_DIR;
    process.env.JARVIS_WORKFLOW_DATA_DIR = directory; initWorkflowDb(':memory:'); });
  afterEach(() => { closeWorkflowDb(); if (previous === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR; else process.env.JARVIS_WORKFLOW_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true }); });
  test('through the real engine: approval pauses before writing, an offline machine blocks, and a wrong machine fails', async () => {
    const { createEvaluationEngine } = await import('./engine');
    const { smokeGraphs } = await import('./smoke');
    const engine = await createEvaluationEngine(founder);
    try {
      const notes = byId('dev-weekly-notes-file');
      const [allowed, paused] = await engine.execute(smokeGraphs[notes.id], notes.scenarios);
      expect(allowed).toMatchObject({ status: 'SUCCEEDED', receipts: [{ kind: 'tool', outcome: 'succeeded' }] });
      expect(paused).toMatchObject({ status: 'PAUSED', receipts: [{ kind: 'tool', outcome: 'approval_pending' }] });
      expect([allowed!, paused!].every(s => s.checks.every(c => c.pass))).toBe(true);
      const wrong = structuredClone(smokeGraphs[notes.id]);
      wrong.nextAction.settings.input.params.target = 'Studio PC';
      const [misdirected] = await engine.execute(wrong, [notes.scenarios[0]!]);
      expect(misdirected!.checks.find(c => c.name === 'exact tool calls, parameters and outcomes')!.pass).toBe(false);
      const screen = byId('dev-studio-screen');
      const [, offline] = await engine.execute(smokeGraphs[screen.id], screen.scenarios);
      expect(offline).toMatchObject({ status: 'FAILED', receipts: [{ kind: 'tool', outcome: 'blocked' }] });
      expect(offline!.checks.every(c => c.pass)).toBe(true);
    } finally { await engine.close(); }
  }, 120_000);
}
