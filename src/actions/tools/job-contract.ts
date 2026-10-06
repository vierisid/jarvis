/**
 * Q-04: the requested job as a structured contract, and the check that a
 * composed graph keeps it.
 *
 * A caller states the contract explicitly, beside the job's own wording:
 * nothing here derives one from free text, and the wording is never replaced.
 * The check is structural: it proves the graph's trigger, sources, outputs,
 * recipients and effects match what was stated, and names what it could not
 * prove so a person can review it. It makes no claim about arbitrary language.
 *
 * Bindings that decide where a message goes (recipients, channels, the tool a
 * step calls) must be literal: missing or computed at run time, they are
 * blockers. Connection credentials stay deferred to activation, which already
 * refuses to run without them.
 *
 * What a step can do is known for Jarvis's own pieces, the bounded tools
 * (effect-capabilities.ts) and the governed pieces (piece-effects.ts). An
 * agent, another workflow, an ungoverned piece or any other tool is open: what
 * it does is decided when it runs. An open step is a blocker when the job
 * forbids an effect, and a review item when the job states its outputs or
 * recipients.
 */
import { AUTHORITY_REQUIREMENTS, type ActionCategory } from '../../roles/authority';
import { TOOL_ACTION_MAP } from '../../authority/tool-action-map';
import { getCronTimezone } from '../../lib/cron-scheduler';
import { BOUNDED_TOOL_NAMES } from '../../workflows/runtime/effect-capabilities';
import { GOVERNED_PIECE_ADAPTERS, resolveGovernedPieceAction } from '../../workflows/runtime/piece-effects';
import { walkFlowNodes } from '../../workflows/db/flow-graph';
import type { FlowTriggerNode } from '../../workflows/db/repos/flow-version';

export type ContractValue = string | number | boolean | string[];
/** A step the job must contain: a notification, a Jarvis tool call, or a piece action, with the literal values that matter. */
export type ContractStep =
  | { notify: { channels: string[] } }
  | { tool: string; params?: Record<string, ContractValue> }
  | { piece: string; action?: string; target?: Record<string, ContractValue> };

export type ContractTriggerKind = 'manual' | 'schedule' | 'webhook' | 'event' | 'piece';

export interface JobContract {
  /** How the job starts: a schedule's cron and time zone, a Jarvis event's type, or a piece's own trigger. */
  trigger?: { kind: ContractTriggerKind; cron?: string; timezone?: string; eventType?: string; piece?: string; trigger?: string };
  /** What the job must read. */
  sources?: ContractStep[];
  /** What the job must produce. With outputs, every message the flow sends must be one of them. */
  outputs?: ContractStep[];
  /** The only people and places a message may be sent to: notification channels, addresses, channel and user ids.
   * A draft reaches no one until someone sends it; an output's target states who it is addressed to. */
  recipients?: string[];
  /** What the job must never do. Effects are Authority categories, such as send_email or delete_data. */
  forbidden?: { effects?: ActionCategory[]; pieces?: string[]; actions?: string[]; tools?: string[]; channels?: string[]; agents?: boolean };
  /** Requirements no check can verify; a person confirms them before the flow is published. */
  review?: string[];
}

/** What a passing check proved, and what is left for a person. */
export interface ContractReport { verified: string[]; review: string[] }

export class JobContractError extends Error {}

const SEND_EFFECTS: ReadonlySet<ActionCategory> = new Set(['send_email', 'send_message']);
/** Input props that name who or where a message goes, among a send's inputs. */
const RECIPIENT_PROPS = new Set(['receiver', 'to', 'cc', 'bcc', 'channel', 'channel_id', 'user', 'userId', 'user_id',
  'recipients', 'email', 'chat_id', 'attendees', 'attendee_email']);
const NOTIFY = '@jarvispieces/piece-jarvis-notify', TOOL = '@jarvispieces/piece-jarvis-tool';
const TRIGGER_KINDS: readonly ContractTriggerKind[] = ['manual', 'schedule', 'webhook', 'event', 'piece'];
const MAX_ITEMS = 20, MAX_TEXT = 500;

const fail = (what: string): never => { throw new JobContractError('Invalid job contract: ' + what); };
const unmet = (what: string): never => { throw new JobContractError('Job contract cannot be met: ' + what); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function only(value: Record<string, unknown>, keys: string[], where: string) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where} has an unknown field ${key}`);
}
function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) fail(`${where} must be non-empty text of at most ${MAX_TEXT} characters`);
  return (value as string).trim();
}
function texts(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ITEMS) fail(`${where} must list 1 to ${MAX_ITEMS} values`);
  return (value as unknown[]).map((v, i) => text(v, `${where}[${i}]`));
}
const optional = (value: Record<string, unknown>, key: string, where: string) =>
  value[key] === undefined ? {} : { [key]: text(value[key], `${where}.${key}`) };
function literal(value: unknown, where: string): ContractValue {
  if (Array.isArray(value)) return texts(value, where);
  if (typeof value === 'string') return text(value, where);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return fail(`${where} must be literal text, a number, true or false, or a list of text`);
}
function literals(value: unknown, where: string): Record<string, ContractValue> {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).length > MAX_ITEMS) fail(`${where} must be an object of 1 to ${MAX_ITEMS} values`);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, literal(v, `${where}.${k}`)]));
}
function step(value: unknown, where: string, notify: boolean): ContractStep {
  if (!object(value)) return fail(`${where} must be an object`);
  if ('notify' in value) {
    if (!notify) fail(`${where} cannot be a notification`);
    only(value, ['notify'], where);
    if (!object(value.notify)) fail(`${where}.notify must be an object`);
    only(value.notify as Record<string, unknown>, ['channels'], `${where}.notify`);
    return { notify: { channels: texts((value.notify as Record<string, unknown>).channels, `${where}.notify.channels`) } };
  }
  if ('tool' in value) {
    only(value, ['tool', 'params'], where);
    return { tool: text(value.tool, `${where}.tool`), ...(value.params !== undefined ? { params: literals(value.params, `${where}.params`) } : {}) };
  }
  if ('piece' in value) {
    only(value, ['piece', 'action', 'target'], where);
    const piece = text(value.piece, `${where}.piece`);
    // One spelling each, so a notification or a tool call is checked by its channels or its tool.
    if (samePiece(piece, NOTIFY)) fail(`${where} names a notification; state it as {notify: {channels}}`);
    if (samePiece(piece, TOOL)) fail(`${where} names a tool call; state it as {tool, params}`);
    return { piece, ...optional(value, 'action', where), ...(value.target !== undefined ? { target: literals(value.target, `${where}.target`) } : {}) };
  }
  return fail(`${where} must name a notify, tool or piece`);
}
const normalizeCron = (cron: string) => cron.trim().split(/\s+/).join(' ');
/** The canonical IANA name, or null for an unknown zone. */
function zoneName(zone: string): string | null {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone; } catch { return null; }
}
/** The time zone every workflow schedule runs in: Jarvis's configured one, else this machine's (lib/cron-scheduler.ts). */
export function scheduleTimeZone(): string {
  return zoneName(getCronTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
}
/** The effect a required step would have, when a table knows it. */
function requiredEffect(s: ContractStep): ActionCategory | null {
  if ('notify' in s) return 'send_message';
  if ('tool' in s) return Object.hasOwn(TOOL_ACTION_MAP, s.tool) ? TOOL_ACTION_MAP[s.tool]! : null;
  const adapter = GOVERNED_PIECE_ADAPTERS.find(a => samePiece(s.piece, a.pieceName));
  return adapter && s.action ? resolveGovernedPieceAction(adapter.pieceName, s.action)?.category ?? null : null;
}

/** A validated, normalized copy. Throws JobContractError naming the first problem. */
export function validateJobContract(value: unknown): JobContract {
  if (!object(value)) return fail('expected an object');
  only(value, ['trigger', 'sources', 'outputs', 'recipients', 'forbidden', 'review'], 'contract');
  const contract: JobContract = {};
  if (value.trigger !== undefined) {
    const t = value.trigger;
    if (!object(t)) return fail('trigger must be an object');
    only(t, ['kind', 'cron', 'timezone', 'eventType', 'piece', 'trigger'], 'trigger');
    if (!TRIGGER_KINDS.includes(t.kind as ContractTriggerKind)) fail('trigger.kind must be manual, schedule, webhook, event or piece');
    const kind = t.kind as ContractTriggerKind;
    if ((t.cron !== undefined || t.timezone !== undefined) && kind !== 'schedule') fail('only a schedule trigger has a cron or timezone');
    if (t.eventType !== undefined && kind !== 'event') fail('only an event trigger has an eventType');
    if ((t.piece !== undefined || t.trigger !== undefined) && kind !== 'piece') fail('only a piece trigger names a piece and its trigger');
    if (kind === 'piece' && t.piece === undefined) fail('a piece trigger must name its piece');
    const cron = t.cron === undefined ? undefined : normalizeCron(text(t.cron, 'trigger.cron'));
    if (cron !== undefined && cron.split(' ').length !== 5) fail('trigger.cron must have 5 fields');
    contract.trigger = { kind, ...(cron ? { cron } : {}), ...optional(t, 'timezone', 'trigger'), ...optional(t, 'eventType', 'trigger'),
      ...optional(t, 'piece', 'trigger'), ...optional(t, 'trigger', 'trigger') };
    const timezone = contract.trigger.timezone;
    if (timezone !== undefined) {
      const zone = zoneName(timezone);
      if (!zone) fail(`trigger.timezone ${timezone} is not a known time zone`);
      // Every schedule runs in one time zone, so a job set in another one would run at the wrong hour.
      if (zone !== scheduleTimeZone()) unmet(`schedules run in ${scheduleTimeZone()}, Jarvis's time zone; the job asks for ${timezone}`);
    }
  }
  for (const key of ['sources', 'outputs'] as const) {
    if (value[key] === undefined) continue;
    const list = value[key];
    if (!Array.isArray(list) || !list.length || list.length > MAX_ITEMS) fail(`${key} must list 1 to ${MAX_ITEMS} steps`);
    contract[key] = (list as unknown[]).map((s, i) => step(s, `${key}[${i}]`, key === 'outputs'));
  }
  if (value.recipients !== undefined) contract.recipients = texts(value.recipients, 'recipients');
  if (value.forbidden !== undefined) {
    const f = value.forbidden;
    if (!object(f)) return fail('forbidden must be an object');
    only(f, ['effects', 'pieces', 'actions', 'tools', 'channels', 'agents'], 'forbidden');
    const forbidden: NonNullable<JobContract['forbidden']> = {};
    if (f.effects !== undefined) {
      forbidden.effects = texts(f.effects, 'forbidden.effects') as ActionCategory[];
      for (const effect of forbidden.effects) if (!Object.hasOwn(AUTHORITY_REQUIREMENTS, effect)) fail(`forbidden.effects has an unknown effect ${effect}`);
    }
    for (const key of ['pieces', 'actions', 'tools', 'channels'] as const) if (f[key] !== undefined) forbidden[key] = texts(f[key], `forbidden.${key}`);
    if (f.agents !== undefined) {
      if (typeof f.agents !== 'boolean') fail('forbidden.agents must be true or false');
      forbidden.agents = f.agents as boolean;
    }
    contract.forbidden = forbidden;
  }
  if (value.review !== undefined) contract.review = texts(value.review, 'review');
  if (!Object.keys(contract).length) fail('it states nothing');
  // A contract that requires what it forbids, or a message to a place it does not allow, can never be met.
  const forbidden = contract.forbidden;
  for (const s of [...contract.sources ?? [], ...contract.outputs ?? []]) {
    const effect = requiredEffect(s);
    if (effect && forbidden?.effects?.includes(effect)) unmet(`it requires ${describe(s)}, which would ${words(effect)}, and forbids ${effect}`);
    if ('tool' in s && forbidden?.tools?.includes(s.tool)) unmet(`it both requires and forbids the tool ${s.tool}`);
    if ('piece' in s && (forbidden?.pieces?.some(p => samePiece(p, s.piece))
      || (s.action && forbidden?.actions?.includes(s.action)))) unmet(`it both requires and forbids ${describe(s)}`);
    if ('notify' in s) for (const channel of s.notify.channels) {
      if (forbidden?.channels?.includes(channel)) unmet(`it both requires and forbids the channel ${channel}`);
      if (contract.recipients && !contract.recipients.includes(channel)) unmet(`it requires a notification to ${channel}, which recipients do not allow`);
    }
  }
  return contract;
}

/* ---------------------------------------------------------------- checking */

const isExpression = (value: unknown) => typeof value === 'string' && value.includes('{{');
const words = (effect: ActionCategory) => effect.replace(/_/g, ' ');
/** A piece named by npm name or short name: `@activepieces/piece-gmail`, `gmail`, `jarvis-notify`. A governed
 * piece's catalog id is its short name. */
function samePiece(named: string, pieceName: string): boolean {
  return named === pieceName || pieceName.endsWith(`/piece-${named}`) || named.endsWith(`/piece-${pieceName}`);
}
/** A list-valued input, given as an array or as JSON text of one. */
function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* plain text */ }
  }
  return value === undefined || value === null || value === '' ? [] : [value];
}
/** A tool step's params, given as an object or as JSON text of one. */
function paramsOf(input: Record<string, unknown>): Record<string, unknown> {
  const params = input.params;
  if (object(params)) return params;
  if (typeof params === 'string') {
    try { const parsed = JSON.parse(params); if (object(parsed)) return parsed; } catch { /* not JSON */ }
  }
  return {};
}
const sameValue = (want: ContractValue, got: unknown) => Array.isArray(want)
  ? JSON.stringify([...want].sort()) === JSON.stringify(listOf(got).map(String).sort())
  : want === got || (typeof want !== 'string' && String(want) === String(got));

interface Step {
  name: string; pieceName: string; actionName: string; input: Record<string, unknown>;
  kind: 'notify' | 'tool' | 'agent' | 'piece';
  toolName?: unknown;
  /** The Authority category the runtime records for the step, or null when no table knows it. */
  effect: ActionCategory | null;
  /** Why what the step does is decided when it runs. Absent when `effect` bounds it. */
  open?: string;
  /** The tool is chosen at run time: an unresolved binding. */
  runtimeTool?: true;
  /** Who or where a message goes, by input prop: literal values, or the raw value when computed at run time. */
  recipients: Array<{ prop: string; value: unknown }>;
}
/** Jarvis pieces that only read or compute (the runtime records Ask and context as read_data). */
const JARVIS_READS = ['jarvis-ask', 'jarvis-regex', 'jarvis-context', 'jarvis-validate'];
/** A notification with no channels, or `auto`, goes to whichever channels are connected when it runs. */
const AUTO = '{{connected channels}}';
const addressed = (values: Record<string, unknown>, props: Iterable<string>) =>
  [...props].flatMap(prop => listOf(values[prop]).map(value => ({ prop, value })));

function classify(node: FlowTriggerNode): Step | null {
  if (node.type !== 'PIECE') return null;
  const pieceName = String(node.settings?.pieceName ?? ''), actionName = String(node.settings?.actionName ?? '');
  const input = (object(node.settings?.input) ? node.settings!.input : {}) as Record<string, unknown>;
  const base = { name: node.name, pieceName, actionName, input, recipients: [] as Step['recipients'] };
  if (samePiece('jarvis-notify', pieceName)) {
    const channels = listOf(input.channels);
    return { ...base, kind: 'notify', effect: 'send_message',
      recipients: (channels.length ? channels : ['auto']).map(value => ({ prop: 'channels', value: value === 'auto' ? AUTO : value })) };
  }
  if (samePiece('jarvis-tool', pieceName)) {
    const toolName = input.toolName;
    if (typeof toolName !== 'string' || !toolName.trim() || isExpression(toolName))
      return { ...base, kind: 'tool', toolName, effect: null, open: 'chooses its tool at run time', runtimeTool: true };
    const effect = Object.hasOwn(TOOL_ACTION_MAP, toolName) ? TOOL_ACTION_MAP[toolName]! : null;
    return { ...base, kind: 'tool', toolName, effect,
      recipients: effect && SEND_EFFECTS.has(effect) ? addressed(paramsOf(input), RECIPIENT_PROPS) : [],
      // Only a bounded tool's category bounds what it does; any other tool's effect depends on the call.
      ...(effect && BOUNDED_TOOL_NAMES.has(toolName) ? {} : { open: `calls ${toolName}, which Jarvis cannot bound before it runs` }) };
  }
  if (samePiece('jarvis-agent', pieceName))
    return { ...base, kind: 'agent', effect: 'spawn_agent', open: 'delegates to an agent, which chooses its own tools when it runs' };
  if (samePiece('jarvis-trigger', pieceName))
    return { ...base, kind: 'piece', effect: 'spawn_agent', open: 'starts another workflow, whose steps this check does not see' };
  const governed = resolveGovernedPieceAction(pieceName, actionName);
  if (governed) {
    const props = governed.adapter.targetProps.filter(p => RECIPIENT_PROPS.has(p));
    return { ...base, kind: 'piece', effect: governed.category, recipients: SEND_EFFECTS.has(governed.category) ? addressed(input, props) : [] };
  }
  if (JARVIS_READS.some(p => samePiece(p, pieceName))) return { ...base, kind: 'piece', effect: 'read_data' };
  return { ...base, kind: 'piece', effect: null, open: `uses ${pieceName}${actionName ? ' ' + actionName : ''}, which Jarvis does not govern` };
}

/** A tool or piece step with the stated values. Notifications are matched by channel. */
function matches(step: Step, want: ContractStep): boolean {
  if ('notify' in want) return false;
  if ('tool' in want) return step.kind === 'tool' && step.toolName === want.tool
    && Object.entries(want.params ?? {}).every(([k, v]) => sameValue(v, paramsOf(step.input)[k]));
  return samePiece(want.piece, step.pieceName) && (!want.action || want.action === step.actionName)
    && Object.entries(want.target ?? {}).every(([k, v]) => sameValue(v, step.input[k]));
}
/** The channels some notification reaches, as stated in the graph. */
const notified = (steps: Step[]) => new Set(steps.filter(s => s.kind === 'notify').flatMap(s => s.recipients.map(r => r.value)));
function satisfied(want: ContractStep, steps: Step[]): boolean {
  if ('notify' in want) {
    const reached = notified(steps);
    return want.notify.channels.every(c => reached.has(c));
  }
  return steps.some(s => matches(s, want));
}
function describe(s: ContractStep): string {
  return 'notify' in s ? `a notification to ${s.notify.channels.join(', ')}` : 'tool' in s ? `the ${s.tool} tool` : `${s.piece}${s.action ? ' ' + s.action : ''}`;
}
const clip = (value: unknown) => {
  const shown = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return shown.length > 80 ? shown.slice(0, 77) + '...' : shown;
};
const shown = (value: unknown) => listOf(value).map(v => v === AUTO ? 'the connected channels' : clip(v)).join(', ') || 'nothing';
const computed = (value: unknown) => listOf(value).some(isExpression);

/** Why no step satisfies `want`, pointing at the nearest step and the first value it gets wrong. */
function miss(want: ContractStep, steps: Step[], verb: 'reads from' | 'produces'): string {
  if ('notify' in want) {
    const reached = notified(steps);
    return `no notification goes to ${want.notify.channels.filter(c => !reached.has(c)).join(', ')}` + steps.filter(s => s.kind === 'notify')
      .map(s => `; step "${s.name}" notifies ${shown(s.recipients.map(r => r.value))}`).join('');
  }
  const near = steps.find(s => 'tool' in want ? s.kind === 'tool' && s.toolName === want.tool
    : samePiece(want.piece, s.pieceName) && (!want.action || want.action === s.actionName));
  if (near) {
    const actual = 'tool' in want ? paramsOf(near.input) : near.input;
    for (const [key, value] of Object.entries('tool' in want ? want.params ?? {} : want.target ?? {})) {
      if (sameValue(value, actual[key])) continue;
      return computed(actual[key])
        ? `step "${near.name}" decides its ${key} at run time (${clip(actual[key])}); the job needs ${shown(value)}`
        : `step "${near.name}" has ${key} ${shown(actual[key])}; the job asks for ${shown(value)}`;
    }
  }
  return `no step ${verb} ${describe(want)}`;
}

const TRIGGER_WORDS: Record<ContractTriggerKind, string> = {
  manual: 'a manual trigger', schedule: 'a schedule', webhook: 'a webhook', event: 'a Jarvis event', piece: "a piece's own trigger",
};
function triggerKind(trigger: FlowTriggerNode): ContractTriggerKind {
  if (trigger.type === 'EMPTY') return 'manual';
  const piece = String(trigger.settings?.pieceName ?? '');
  return samePiece('schedule', piece) ? 'schedule' : samePiece('webhook', piece) ? 'webhook' : samePiece('jarvis-trigger', piece) ? 'event' : 'piece';
}

/**
 * Every way the graph departs from the contract, as focused messages the
 * repair loop can act on; and, when it keeps the contract, what was proved
 * and what a person must still confirm.
 */
export function checkJobContract(trigger: FlowTriggerNode, contract: JobContract): { violations: string[]; report: ContractReport } {
  const violations: string[] = [], verified: string[] = [];
  const steps = walkFlowNodes(trigger).slice(1).map(classify).filter((s): s is Step => s !== null);

  if (contract.trigger) {
    const want = contract.trigger, settings = trigger.settings ?? {};
    const input = (object(settings.input) ? settings.input : {}) as Record<string, unknown>;
    const kind = triggerKind(trigger), before = violations.length;
    if (kind !== want.kind) violations.push(`the flow starts with ${TRIGGER_WORDS[kind]}; the job asks for ${TRIGGER_WORDS[want.kind]}`);
    else {
      // The keys the trigger manager reads, in its order.
      const cron = [input.cron_expression, input.cronExpression, input.expression].find(v => typeof v === 'string' && v) as string | undefined;
      if (want.cron && normalizeCron(cron ?? '') !== want.cron) violations.push(`the schedule is "${cron ?? ''}"; the job asks for "${want.cron}"`);
      if (want.eventType && input.eventType !== want.eventType) violations.push(`the flow listens for ${clip(input.eventType ?? 'no event')}; the job asks for ${want.eventType}`);
      const piece = String(settings.pieceName ?? ''), name = String(settings.triggerName ?? '');
      if (want.piece && !samePiece(want.piece, piece)) violations.push(`the flow starts on ${piece}; the job asks for ${want.piece}`);
      else if (want.trigger && name !== want.trigger) violations.push(`the flow starts on ${piece} ${name || 'with no trigger named'}; the job asks for ${want.trigger}`);
    }
    if (violations.length === before) verified.push(`starts with ${TRIGGER_WORDS[want.kind]}${want.cron ? ` on "${want.cron}"` : ''}`
      + `${want.timezone ? ` in ${want.timezone}` : ''}${want.eventType ? ` (${want.eventType})` : ''}`
      + `${want.piece ? `: ${want.piece}${want.trigger ? ' ' + want.trigger : ''}` : ''}`);
  }
  for (const [key, verb] of [['sources', 'reads from'], ['outputs', 'produces']] as const) {
    for (const want of contract[key] ?? []) {
      if (satisfied(want, steps)) verified.push(`${verb} ${describe(want)}`);
      else violations.push(miss(want, steps, verb));
    }
  }

  // A step that sends: a notification, a send by a governed piece, or a tool whose action is a send.
  const sends = steps.filter(s => s.effect !== null && SEND_EFFECTS.has(s.effect));
  // Steps that do what they decide when they run. A run-time tool choice is a blocker below, not a review item.
  const open = steps.filter(s => s.open && !s.runtimeTool);
  const named = (s: Step) => [...contract.sources ?? [], ...contract.outputs ?? []].some(want => matches(s, want));
  if (contract.outputs) {
    const before = violations.length;
    const asked = new Set(contract.outputs.flatMap(o => 'notify' in o ? o.notify.channels : []));
    for (const s of sends) {
      if (s.kind !== 'notify') {
        if (!contract.outputs.some(want => matches(s, want))) violations.push(`step "${s.name}" sends a message the job did not ask for`);
      } else if (!asked.size) violations.push(`step "${s.name}" sends a notification the job did not ask for`);
      else for (const r of s.recipients) {
        if (!isExpression(r.value) && !asked.has(String(r.value))) violations.push(`step "${s.name}" notifies ${clip(r.value)}, which the job did not ask for`);
      }
    }
    if (violations.length === before && !open.some(s => !named(s))) verified.push('sends nothing beyond the requested outputs');
  }
  if (contract.recipients || contract.outputs) {
    const before = violations.length;
    for (const s of sends) {
      if (!s.recipients.length) violations.push(`step "${s.name}" sends without stating who receives it; the job needs it stated`);
      for (const r of s.recipients) {
        if (isExpression(r.value)) violations.push(`step "${s.name}" decides its ${r.prop} at run time (${shown(r.value)}); the job needs it stated`);
        else if (contract.recipients && !contract.recipients.includes(String(r.value)))
          violations.push(`step "${s.name}" sends to ${clip(r.value)}, which the job does not allow`);
      }
    }
    if (contract.recipients && violations.length === before && !open.length) verified.push(`messages reach only ${contract.recipients.join(', ')}`);
  }
  if (contract.outputs || contract.recipients || contract.forbidden) {
    for (const s of steps) if (s.runtimeTool) violations.push(`step "${s.name}" chooses its tool at run time; the job needs it stated`);
  }
  const forbidden = contract.forbidden;
  if (forbidden) {
    const before = violations.length;
    for (const s of steps) {
      if (forbidden.effects?.length && !s.runtimeTool) {
        if (s.effect && forbidden.effects.includes(s.effect)) violations.push(`step "${s.name}" would ${words(s.effect)}, which the job forbids`);
        // What an open step does is decided when it runs, so it cannot be shown to keep a negative constraint.
        else if (s.open) violations.push(`step "${s.name}" ${s.open}, so it cannot be shown to avoid ${forbidden.effects.join(', ')}`);
      }
      if (forbidden.pieces?.some(p => samePiece(p, s.pieceName))) violations.push(`step "${s.name}" uses ${s.pieceName}, which the job forbids`);
      if (forbidden.actions?.includes(s.actionName)) violations.push(`step "${s.name}" runs ${s.actionName}, which the job forbids`);
      if (s.kind === 'tool' && typeof s.toolName === 'string' && forbidden.tools?.includes(s.toolName)) violations.push(`step "${s.name}" calls ${s.toolName}, which the job forbids`);
      if (s.kind === 'agent' && forbidden.agents) violations.push(`step "${s.name}" delegates to an agent, which the job forbids`);
      for (const r of s.recipients) {
        if (forbidden.channels?.length && isExpression(r.value))
          violations.push(`step "${s.name}" decides its ${r.prop} at run time (${shown(r.value)}), so it cannot be shown to avoid ${forbidden.channels.join(', ')}`);
        else if (forbidden.channels?.includes(String(r.value))) violations.push(`step "${s.name}" sends to ${clip(r.value)}, which the job forbids`);
      }
    }
    if (violations.length === before) verified.push('does nothing the job forbids' + (forbidden.effects?.length ? ` (${forbidden.effects.join(', ')})` : ''));
  }

  // A person confirms what no check could prove: the caller's own items, then each open step's reach.
  const review = [...contract.review ?? []];
  if (contract.outputs || contract.recipients) for (const s of open) {
    const confirm = [...(contract.outputs && !named(s) ? ['sends nothing the job did not ask for'] : []),
      ...(contract.recipients ? [`reaches only ${contract.recipients.join(', ')}`] : [])];
    if (confirm.length) review.push(`confirm step "${s.name}" ${confirm.join(' and ')}: it ${s.open}`);
  }
  return { violations: [...new Set(violations)].map(v => 'job contract: ' + v), report: { verified, review } };
}
