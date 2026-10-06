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
 * A step reaches people when it sends (a send category, a notification) or
 * when a write addresses them: a calendar event's attendees, a share's user, a
 * draft's receiver, a file posted to a channel. Where the job constrains a
 * destination, a destination missing or decided at run time is a blocker.
 * Connection credentials stay deferred to activation, which already refuses
 * to run without them.
 *
 * What a step can do is known for Jarvis's own pieces, the bounded tools
 * (effect-capabilities.ts) and the governed piece actions (piece-effects.ts).
 * Anything else is open: an agent, another workflow, any other tool, an
 * ungoverned piece, or a governed action whose reach depends on the call. An
 * open step blocks when the job forbids something it could reach; otherwise
 * it becomes a review item, and the report withholds every claim it could
 * break.
 */
import { AUTHORITY_REQUIREMENTS, type ActionCategory } from '../../roles/authority';
import { TOOL_ACTION_MAP } from '../../authority/tool-action-map';
import { getCronTimezone } from '../../lib/cron-scheduler';
import { VERIFIED_MANIFESTS } from '../../workflows/pieces-library/verified-manifests-generated';
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
/** How often a schedule fires, when the job states a cadence rather than an exact time. */
export type ContractCadence = 'hour' | 'day' | 'week' | 'month';

export interface JobContract {
  /** How the job starts: a schedule's cron, cadence and time zone, a Jarvis event's type, or a piece's own trigger. */
  trigger?: {
    kind: ContractTriggerKind; cron?: string; every?: ContractCadence; timezone?: string;
    eventType?: string; piece?: string; trigger?: string;
  };
  /** What the job must read, through a step or the trigger. */
  sources?: ContractStep[];
  /** What the job must produce. With outputs, everything the flow sends or addresses must be one of them. */
  outputs?: ContractStep[];
  /** The only people and places the flow may send to or address: notification channels, addresses, channel and user ids. */
  recipients?: string[];
  /** What the job must never do. Effects are Authority categories, such as send_email or delete_data. */
  forbidden?: { effects?: ActionCategory[]; pieces?: string[]; actions?: string[]; tools?: string[]; channels?: string[]; agents?: boolean };
  /** Requirements no check can verify, for a person to confirm. The report returns them; nothing enforces them. */
  review?: string[];
}

/** What a passing check proved, and what is left for a person. */
export interface ContractReport { verified: string[]; review: string[] }

export class JobContractError extends Error {}

const SEND_EFFECTS: ReadonlySet<ActionCategory> = new Set(['send_email', 'send_message']);
/** Input props that name who or where a step reaches. */
const RECIPIENT_PROPS = new Set(['receiver', 'to', 'cc', 'bcc', 'channel', 'channel_id', 'user', 'userId', 'user_id', 'users',
  'recipients', 'email', 'user_email', 'chat_id', 'attendees', 'attendee_email']);
/** Governed actions that call the service's API directly: their category is a worst case, not a bound. */
const OPEN_ACTIONS = new Set(['custom_api_call', 'rawGraphqlQuery']);
const NOTIFY = '@jarvispieces/piece-jarvis-notify', TOOL = '@jarvispieces/piece-jarvis-tool';
const AGENT = '@jarvispieces/piece-jarvis-agent', WORKFLOW = '@jarvispieces/piece-jarvis-trigger';
const TRIGGER_KINDS: readonly ContractTriggerKind[] = ['manual', 'schedule', 'webhook', 'event', 'piece'];
const CADENCES: readonly ContractCadence[] = ['hour', 'day', 'week', 'month'];
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
    const channels = texts((value.notify as Record<string, unknown>).channels, `${where}.notify.channels`);
    if (channels.includes('auto')) fail(`${where}.notify.channels must name channels; auto is decided at run time`);
    return { notify: { channels } };
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
/** How often a 5-field cron fires when it is a plain cadence: once an hour, a day, a week or a month. */
function cadence(cron: string): ContractCadence | null {
  const [minute, hour, dom, month, dow] = normalizeCron(cron).split(' ');
  const one = (field?: string) => !!field && /^\d+$/.test(field);
  if (!one(minute) || month !== '*') return null;
  if (hour === '*' && dom === '*' && dow === '*') return 'hour';
  if (!one(hour)) return null;
  if (dom === '*' && dow === '*') return 'day';
  if (dom === '*' && one(dow)) return 'week';
  return one(dom) && dow === '*' ? 'month' : null;
}
/** The canonical IANA name, or null for an unknown zone. */
function zoneName(zone: string): string | null {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone; } catch { return null; }
}
/** The time zone every workflow schedule runs in: Jarvis's configured one, else this machine's (lib/cron-scheduler.ts). */
export function scheduleTimeZone(): string {
  return zoneName(getCronTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
}

/** What a step is, judged by the same rules for a graph step and a step the contract requires. */
interface Kind {
  effect: ActionCategory | null;
  /** Why what the step does is decided when it runs. Absent when `effect` bounds it. */
  open?: string;
  /** An open step that acts only through its own service: it can reach any effect and address there, but no Jarvis tool, agent or other piece. */
  serviceOnly?: true;
  agent?: true;
}
function pieceKind(pieceName: string, actionName: string | undefined): Kind | null {
  if (samePiece(pieceName, AGENT)) return { effect: 'spawn_agent', open: 'delegates to an agent, which chooses its own tools when it runs', agent: true };
  if (samePiece(pieceName, WORKFLOW)) return { effect: 'spawn_agent', open: 'starts another workflow, whose steps this check does not see' };
  const adapter = GOVERNED_PIECE_ADAPTERS.find(a => samePiece(pieceName, a.pieceName));
  if (adapter) {
    if (!actionName) return null;
    const governed = resolveGovernedPieceAction(adapter.pieceName, actionName);
    if (!governed) return null;
    return OPEN_ACTIONS.has(actionName) || !governed.known
      ? { effect: governed.category, open: `uses ${pieceName} ${actionName}, whose effect depends on the call`, serviceOnly: true }
      : { effect: governed.category };
  }
  if (JARVIS_READS.some(p => samePiece(p, pieceName))) return { effect: 'read_data' };
  return { effect: null, open: `uses ${pieceName}${actionName ? ' ' + actionName : ''}, which Jarvis does not govern`, serviceOnly: true };
}
function toolKind(toolName: string): Kind {
  const effect = Object.hasOwn(TOOL_ACTION_MAP, toolName) ? TOOL_ACTION_MAP[toolName]! : null;
  // Only a bounded tool's category bounds what it does; any other tool's effect depends on the call.
  return effect && BOUNDED_TOOL_NAMES.has(toolName) ? { effect } : { effect, open: `calls ${toolName}, which Jarvis cannot bound before it runs` };
}
/** The parts of the forbidden list an open step could break when it runs. */
function exposure(kind: Kind, forbidden: NonNullable<JobContract['forbidden']>): string[] {
  const parts: string[] = [...forbidden.effects ?? [], ...(forbidden.channels ?? []).map(c => `channel ${c}`)];
  if (!kind.serviceOnly) {
    parts.push(...(forbidden.tools ?? []).map(t => `tool ${t}`), ...(forbidden.pieces ?? []).map(p => `piece ${p}`),
      ...(forbidden.actions ?? []).map(a => `action ${a}`), ...(forbidden.agents && !kind.agent ? ['agents'] : []));
  }
  return parts;
}
const requiredKind = (s: ContractStep): Kind | null =>
  'notify' in s ? { effect: 'send_message' } : 'tool' in s ? toolKind(s.tool) : pieceKind(s.piece, s.action);
/** The input props a governed action declares, from the verified manifest, or null when no manifest lists it. */
function declaredProps(pieceName: string, actionName: string): string[] | null {
  const adapter = GOVERNED_PIECE_ADAPTERS.find(a => samePiece(pieceName, a.pieceName));
  return (adapter && VERIFIED_MANIFESTS[adapter.catalogId]?.actions.find(a => a.name === actionName)?.props) ?? null;
}

/** A validated, normalized copy. Throws JobContractError naming the first problem. */
export function validateJobContract(value: unknown): JobContract {
  if (!object(value)) return fail('expected an object');
  only(value, ['trigger', 'sources', 'outputs', 'recipients', 'forbidden', 'review'], 'contract');
  const contract: JobContract = {};
  if (value.trigger !== undefined) {
    const t = value.trigger;
    if (!object(t)) return fail('trigger must be an object');
    only(t, ['kind', 'cron', 'every', 'timezone', 'eventType', 'piece', 'trigger'], 'trigger');
    if (!TRIGGER_KINDS.includes(t.kind as ContractTriggerKind)) fail('trigger.kind must be manual, schedule, webhook, event or piece');
    const kind = t.kind as ContractTriggerKind;
    if ((t.cron !== undefined || t.every !== undefined || t.timezone !== undefined) && kind !== 'schedule') fail('only a schedule trigger has a cron, cadence or timezone');
    if (t.eventType !== undefined && kind !== 'event') fail('only an event trigger has an eventType');
    if ((t.piece !== undefined || t.trigger !== undefined) && kind !== 'piece') fail('only a piece trigger names a piece and its trigger');
    if (kind === 'piece' && t.piece === undefined) fail('a piece trigger must name its piece');
    if (t.every !== undefined && !CADENCES.includes(t.every as ContractCadence)) fail('trigger.every must be hour, day, week or month');
    const cron = t.cron === undefined ? undefined : normalizeCron(text(t.cron, 'trigger.cron'));
    if (cron !== undefined && cron.split(' ').length !== 5) fail('trigger.cron must have 5 fields');
    const every = t.every as ContractCadence | undefined;
    if (cron && every && cadence(cron) !== every) unmet(`its cron "${cron}" does not run once every ${every}`);
    contract.trigger = { kind, ...(cron ? { cron } : {}), ...(every ? { every } : {}), ...optional(t, 'timezone', 'trigger'),
      ...optional(t, 'eventType', 'trigger'), ...optional(t, 'piece', 'trigger'), ...optional(t, 'trigger', 'trigger') };
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
  meetable(contract);
  return contract;
}

/** Refuses a contract no graph can keep, judging each required step by the rules the check applies to the graph. */
function meetable(contract: JobContract): void {
  const forbidden = contract.forbidden;
  for (const s of contract.sources ?? []) {
    const kind = requiredKind(s);
    // The trigger can also read a piece, so only a step whose known effect is not a read can never be a source.
    if (kind?.effect && !kind.open && kind.effect !== 'read_data') unmet(`it requires reading from ${describe(s)}, which does not read`);
  }
  for (const s of [...contract.sources ?? [], ...contract.outputs ?? []]) {
    const kind = requiredKind(s);
    if ('tool' in s && forbidden?.tools?.includes(s.tool)) unmet(`it both requires and forbids the tool ${s.tool}`);
    if ('piece' in s && (forbidden?.pieces?.some(p => samePiece(p, s.piece))
      || (s.action && forbidden?.actions?.includes(s.action)))) unmet(`it both requires and forbids ${describe(s)}`);
    if (kind?.agent && forbidden?.agents) unmet('it both requires and forbids an agent');
    if (kind?.effect && forbidden?.effects?.includes(kind.effect)) unmet(`it requires ${describe(s)}, which would ${words(kind.effect)}, and forbids ${kind.effect}`);
  }
  for (const s of contract.outputs ?? []) {
    const kind = requiredKind(s);
    const exposed = kind?.open && forbidden ? exposure(kind, forbidden) : [];
    if (exposed.length) unmet(`it requires ${describe(s)}, whose effects are decided when it runs, and forbids ${exposed.join(', ')}`);
    if ('notify' in s) for (const channel of s.notify.channels) {
      if (forbidden?.channels?.includes(channel)) unmet(`it both requires and forbids the channel ${channel}`);
      if (contract.recipients && !contract.recipients.includes(channel)) unmet(`it requires a notification to ${channel}, which recipients do not allow`);
    }
    const values = 'tool' in s ? s.params : 'piece' in s ? s.target : undefined;
    for (const [prop, value] of Object.entries(values ?? {})) {
      if (!RECIPIENT_PROPS.has(prop)) continue;
      for (const v of listOf(value).map(String)) {
        if (contract.recipients && !contract.recipients.includes(v)) unmet(`it requires ${describe(s)} addressed to ${v}, which recipients do not allow`);
        if (forbidden?.channels?.includes(v)) unmet(`it both requires and forbids ${v}`);
      }
    }
    // A send that cannot state its recipient can never show it reaches only the allowed ones.
    if (contract.recipients && 'piece' in s && s.action && kind?.effect && SEND_EFFECTS.has(kind.effect)) {
      const props = declaredProps(s.piece, s.action);
      if (props && !props.some(p => RECIPIENT_PROPS.has(p))) unmet(`it requires ${describe(s)}, which does not state who receives it, and limits recipients`);
    }
  }
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
/** Both sides the same way: a single value is a list of one, and every value compares as text. */
const normalized = (value: unknown) =>
  JSON.stringify(listOf(value).map(v => typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)).sort());
const sameValue = (want: ContractValue, got: unknown) => normalized(want) === normalized(got);

interface Step extends Kind {
  name: string; pieceName: string; actionName: string; input: Record<string, unknown>;
  kind: 'trigger' | 'notify' | 'tool' | 'agent' | 'workflow' | 'piece';
  toolName?: unknown;
  /** The tool is chosen at run time: an unresolved binding. */
  runtimeTool?: true;
  /** How the step reaches people: it sends, or a write addresses them. */
  reach?: 'send' | 'address';
  /** Who or where it reaches, by input prop: literal values, or the raw value when computed at run time. */
  recipients: Array<{ prop: string; value: unknown }>;
}
/** Jarvis pieces that only read or compute (the runtime records Ask and context as read_data). */
const JARVIS_READS = ['jarvis-ask', 'jarvis-regex', 'jarvis-context', 'jarvis-validate'];
/** A notification with no channels, or `auto`, goes to whichever channels are connected when it runs. */
const AUTO = '{{connected channels}}';

/** Sends reach their recipients; a write or settings change reaches whoever its inputs address. */
function reachOf(effect: ActionCategory | null, values: Record<string, unknown>): Pick<Step, 'reach' | 'recipients'> {
  const recipients = Object.keys(values).filter(p => RECIPIENT_PROPS.has(p)).flatMap(prop => listOf(values[prop]).map(value => ({ prop, value })));
  if (effect && SEND_EFFECTS.has(effect)) return { reach: 'send', recipients };
  return (effect === 'write_data' || effect === 'modify_settings') && recipients.length ? { reach: 'address', recipients } : { recipients: [] };
}

function classify(node: FlowTriggerNode, root: boolean): Step | null {
  const pieceName = String(node.settings?.pieceName ?? '');
  const input = (object(node.settings?.input) ? node.settings!.input : {}) as Record<string, unknown>;
  // The trigger reads: events, a schedule's tick, or a piece's new items.
  if (root) return { name: node.name, pieceName, actionName: String(node.settings?.triggerName ?? ''), input, kind: 'trigger', effect: 'read_data', recipients: [] };
  if (node.type !== 'PIECE') return null;
  const actionName = String(node.settings?.actionName ?? '');
  const base = { name: node.name, pieceName, actionName, input, recipients: [] as Step['recipients'] };
  if (samePiece('jarvis-notify', pieceName)) {
    const channels = listOf(input.channels);
    return { ...base, kind: 'notify', effect: 'send_message', reach: 'send',
      recipients: (channels.length ? channels : ['auto']).map(value => ({ prop: 'channels', value: value === 'auto' ? AUTO : value })) };
  }
  if (samePiece('jarvis-tool', pieceName)) {
    const toolName = input.toolName;
    if (typeof toolName !== 'string' || !toolName.trim() || isExpression(toolName))
      return { ...base, kind: 'tool', toolName, effect: null, open: 'chooses its tool at run time', runtimeTool: true };
    const kind = toolKind(toolName);
    return { ...base, kind: 'tool', toolName, ...kind, ...(kind.open ? {} : reachOf(kind.effect, paramsOf(input))) };
  }
  const kind = pieceKind(pieceName, actionName) ?? { effect: null, open: `uses ${pieceName} ${actionName}, which Jarvis does not govern`, serviceOnly: true as const };
  const what = samePiece(pieceName, AGENT) ? 'agent' : samePiece(pieceName, WORKFLOW) ? 'workflow' : 'piece';
  return { ...base, kind: what, ...kind, ...(kind.open ? {} : reachOf(kind.effect, input)) };
}

/** A step with the stated values: the tool or piece action, and every pinned param or target value. */
function matches(step: Step, want: ContractStep): boolean {
  if ('notify' in want) return false;
  if ('tool' in want) return step.kind === 'tool' && step.toolName === want.tool
    && Object.entries(want.params ?? {}).every(([k, v]) => sameValue(v, paramsOf(step.input)[k]));
  return samePiece(want.piece, step.pieceName) && (!want.action || want.action === step.actionName)
    && Object.entries(want.target ?? {}).every(([k, v]) => sameValue(v, step.input[k]));
}
/** The same step, whatever its values. */
function nearTo(step: Step, want: ContractStep): boolean {
  if ('notify' in want) return false;
  if ('tool' in want) return step.kind === 'tool' && step.toolName === want.tool;
  return samePiece(want.piece, step.pieceName) && (!want.action || want.action === step.actionName);
}
/** A step can serve as a source when it reads, or when it is open and the job named it. The trigger reads. */
const reads = (s: Step) => s.effect === 'read_data' || !!s.open;
/** An output pinning the action and its values names exactly what the job asked the step to do. */
const pinned = (want: ContractStep) => 'tool' in want ? !!want.params : 'piece' in want ? !!want.action && !!want.target : false;
/** The channels some notification reaches, as stated in the graph. */
const notified = (steps: Step[]) => new Set(steps.filter(s => s.kind === 'notify').flatMap(s => s.recipients.map(r => r.value)));
function describe(s: ContractStep): string {
  return 'notify' in s ? `a notification to ${s.notify.channels.join(', ')}` : 'tool' in s ? `the ${s.tool} tool` : `${s.piece}${s.action ? ' ' + s.action : ''}`;
}
const stepWords = (s: Step) => s.kind === 'tool' ? `the ${String(s.toolName)} tool` : `${s.pieceName}${s.actionName ? ' ' + s.actionName : ''}`;
const clip = (value: unknown) => {
  const shown = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return shown.length > 80 ? shown.slice(0, 77) + '...' : shown;
};
const shown = (value: unknown) => listOf(value).map(v => v === AUTO ? 'the connected channels' : clip(v)).join(', ') || 'nothing';
const computed = (value: unknown) => listOf(value).some(isExpression);

/** Why no step satisfies `want`, pointing at the nearest step and the first value it gets wrong. */
function miss(want: ContractStep, steps: Step[], source: boolean): { message: string; near?: Step } {
  const verb = source ? 'reads from' : 'produces';
  if ('notify' in want) {
    const reached = notified(steps);
    return { message: `no notification goes to ${want.notify.channels.filter(c => !reached.has(c)).join(', ')}` + steps.filter(s => s.kind === 'notify')
      .map(s => `; step "${s.name}" notifies ${shown(s.recipients.map(r => r.value))}`).join('') };
  }
  const candidates = steps.filter(s => nearTo(s, want));
  const near = candidates.find(s => !source || reads(s)) ?? candidates[0];
  if (near && source && !reads(near)) return { message: `step "${near.name}" uses ${stepWords(near)}, which does not read; the job reads from ${describe(want)}` };
  if (near) {
    const actual = 'tool' in want ? paramsOf(near.input) : near.input;
    for (const [key, value] of Object.entries('tool' in want ? want.params ?? {} : want.target ?? {})) {
      if (sameValue(value, actual[key])) continue;
      const stated = shown(actual[key]), asked = shown(value);
      return { near, message: computed(actual[key])
        ? `step "${near.name}" decides its ${key} at run time (${clip(actual[key])}); the job needs ${asked}`
        : `step "${near.name}" has ${key} ${stated}; the job asks for ${asked}${stated === asked ? ' (they differ beyond what is shown)' : ''}` };
    }
  }
  return { message: `no step ${verb} ${describe(want)}` };
}

const TRIGGER_WORDS: Record<ContractTriggerKind, string> = {
  manual: 'a manual trigger', schedule: 'a schedule', webhook: 'a webhook', event: 'a Jarvis event', piece: "a piece's own trigger",
};
function triggerKind(trigger: FlowTriggerNode): ContractTriggerKind {
  if (trigger.type === 'EMPTY') return 'manual';
  const piece = String(trigger.settings?.pieceName ?? '');
  return samePiece('schedule', piece) ? 'schedule' : samePiece('webhook', piece) ? 'webhook' : samePiece('jarvis-trigger', piece) ? 'event' : 'piece';
}
function checkTrigger(trigger: FlowTriggerNode, want: NonNullable<JobContract['trigger']>, violations: string[], verified: string[]): void {
  const settings = trigger.settings ?? {};
  const input = (object(settings.input) ? settings.input : {}) as Record<string, unknown>;
  const kind = triggerKind(trigger), before = violations.length;
  if (kind !== want.kind) violations.push(`the flow starts with ${TRIGGER_WORDS[kind]}; the job asks for ${TRIGGER_WORDS[want.kind]}`);
  else {
    // The keys the trigger manager reads, in its order.
    const cron = [input.cron_expression, input.cronExpression, input.expression].find(v => typeof v === 'string' && v) as string | undefined;
    if (want.cron && normalizeCron(cron ?? '') !== want.cron) violations.push(`the schedule is "${cron ?? ''}"; the job asks for "${want.cron}"`);
    else if (want.every && cadence(cron ?? '') !== want.every) {
      const runs = cadence(cron ?? '');
      violations.push(`the schedule "${cron ?? ''}" ${runs ? `runs once every ${runs}` : 'is not an hourly, daily, weekly or monthly schedule'}; the job asks for once every ${want.every}`);
    }
    if (want.eventType && input.eventType !== want.eventType) violations.push(`the flow listens for ${clip(input.eventType ?? 'no event')}; the job asks for ${want.eventType}`);
    const piece = String(settings.pieceName ?? ''), name = String(settings.triggerName ?? '');
    if (want.piece && !samePiece(want.piece, piece)) violations.push(`the flow starts on ${piece}; the job asks for ${want.piece}`);
    else if (want.trigger && name !== want.trigger) violations.push(`the flow starts on ${piece} ${name || 'with no trigger named'}; the job asks for ${want.trigger}`);
  }
  if (violations.length === before) verified.push(`starts with ${TRIGGER_WORDS[want.kind]}${want.cron ? ` on "${want.cron}"` : ''}`
    + `${want.every ? `, once every ${want.every}` : ''}${want.eventType ? ` (${want.eventType})` : ''}`
    + `${want.piece ? `: ${want.piece}${want.trigger ? ' ' + want.trigger : ''}` : ''}`
    // The zone is Jarvis's configuration, checked when the contract was validated, not part of the graph.
    + `${want.timezone ? `; schedules run in ${want.timezone}, as the job asks` : ''}`);
}

/**
 * Every way the graph departs from the contract, as focused messages the
 * repair loop can act on; and, when it keeps the contract, what was proved
 * and what a person must still confirm.
 */
export function checkJobContract(trigger: FlowTriggerNode, contract: JobContract): { violations: string[]; report: ContractReport } {
  const violations: string[] = [], verified: string[] = [];
  const all = walkFlowNodes(trigger).map((node, i) => classify(node, i === 0)).filter((s): s is Step => s !== null);
  const steps = all.slice(1);
  if (contract.trigger) checkTrigger(trigger, contract.trigger, violations, verified);

  // Steps reported through an output they nearly match; the unwanted-send check leaves them to that message.
  const nearMissed = new Set<Step>();
  for (const want of contract.sources ?? []) {
    if (all.some(s => reads(s) && matches(s, want))) verified.push(`reads from ${describe(want)}`);
    else violations.push(miss(want, all, true).message);
  }
  for (const want of contract.outputs ?? []) {
    const reached = notified(steps);
    if ('notify' in want ? want.notify.channels.every(c => reached.has(c)) : steps.some(s => matches(s, want))) verified.push(`produces ${describe(want)}`);
    else {
      const { message, near } = miss(want, steps, false);
      violations.push(message);
      if (near) nearMissed.add(near);
    }
  }

  // Steps that do what they decide when they run. A run-time tool choice is a blocker below, not a review item.
  const open = steps.filter(s => s.open && !s.runtimeTool);
  const namedOutput = (s: Step) => (contract.outputs ?? []).some(want => pinned(want) && matches(s, want));
  const reaching = steps.filter(s => s.reach && !s.open);
  if (contract.outputs) {
    const before = violations.length;
    const asked = new Set(contract.outputs.flatMap(o => 'notify' in o ? o.notify.channels : []));
    for (const s of reaching) {
      if (nearMissed.has(s)) continue;
      if (s.kind === 'notify') {
        if (!asked.size) { violations.push(`step "${s.name}" sends a notification the job did not ask for`); continue; }
        for (const r of s.recipients) {
          // Notifications are outputs by channel, so a channel decided at run time cannot be checked against them.
          if (isExpression(r.value)) violations.push(`step "${s.name}" decides its ${r.prop} at run time (${shown(r.value)}); the job needs it stated`);
          else if (!asked.has(String(r.value))) violations.push(`step "${s.name}" notifies ${clip(r.value)}, which the job did not ask for`);
        }
      } else if (!contract.outputs.some(want => matches(s, want))) {
        violations.push(s.reach === 'send' ? `step "${s.name}" sends a message the job did not ask for`
          : `step "${s.name}" addresses ${shown(s.recipients.map(r => r.value))}, which the job did not ask for`);
      }
    }
    if (violations.length === before && !open.some(s => !namedOutput(s))) verified.push('nothing beyond the requested outputs is sent or addressed');
  }
  if (contract.recipients) {
    const before = violations.length;
    for (const s of reaching) {
      if (s.reach === 'send' && !s.recipients.length) violations.push(`step "${s.name}" sends without stating who receives it; the job needs it stated`);
      for (const r of s.recipients) {
        if (isExpression(r.value)) violations.push(`step "${s.name}" decides its ${r.prop} at run time (${shown(r.value)}); the job needs it stated`);
        else if (!contract.recipients.includes(String(r.value)))
          violations.push(`step "${s.name}" ${s.reach === 'send' ? 'sends to' : 'addresses'} ${clip(r.value)}, which the job does not allow`);
      }
    }
    if (violations.length === before && !open.length) verified.push(`reaches only ${contract.recipients.join(', ')}`);
  }
  if (contract.outputs || contract.recipients || contract.forbidden) {
    for (const s of steps) if (s.runtimeTool) violations.push(`step "${s.name}" chooses its tool at run time; the job needs it stated`);
  }
  const forbidden = contract.forbidden;
  if (forbidden) {
    const before = violations.length;
    if (forbidden.pieces?.some(p => samePiece(p, all[0]?.pieceName ?? ''))) violations.push(`the flow starts on ${all[0]!.pieceName}, which the job forbids`);
    for (const s of steps) {
      if (s.runtimeTool) continue;
      if (s.effect && forbidden.effects?.includes(s.effect)) violations.push(`step "${s.name}" would ${words(s.effect)}, which the job forbids`);
      else if (s.open) {
        // What an open step does is decided when it runs, so it cannot be shown to keep a negative constraint it could reach.
        const exposed = exposure(s, forbidden);
        if (exposed.length) violations.push(`step "${s.name}" ${s.open}, so it cannot be shown to avoid ${exposed.join(', ')}`);
      }
      if (forbidden.pieces?.some(p => samePiece(p, s.pieceName))) violations.push(`step "${s.name}" uses ${s.pieceName}, which the job forbids`);
      if (forbidden.actions?.includes(s.actionName)) violations.push(`step "${s.name}" runs ${s.actionName}, which the job forbids`);
      if (s.kind === 'tool' && typeof s.toolName === 'string' && forbidden.tools?.includes(s.toolName)) violations.push(`step "${s.name}" calls ${s.toolName}, which the job forbids`);
      if (s.kind === 'agent' && forbidden.agents) violations.push(`step "${s.name}" delegates to an agent, which the job forbids`);
      for (const r of s.recipients) {
        if (forbidden.channels?.length && isExpression(r.value))
          violations.push(`step "${s.name}" decides its ${r.prop} at run time (${shown(r.value)}), so it cannot be shown to avoid ${forbidden.channels.join(', ')}`);
        else if (forbidden.channels?.includes(String(r.value))) violations.push(`step "${s.name}" reaches ${clip(r.value)}, which the job forbids`);
      }
    }
    if (violations.length === before) verified.push('does nothing the job forbids' + (forbidden.effects?.length ? ` (${forbidden.effects.join(', ')})` : ''));
  }

  // A person confirms what no check could prove: the caller's own items, then what each open step might reach.
  const review = [...contract.review ?? []];
  for (const s of open) {
    const confirm = [...(contract.outputs && !namedOutput(s) ? ['sends nothing the job did not ask for'] : []),
      ...(contract.recipients ? [`reaches only ${contract.recipients.join(', ')}`] : [])];
    if (confirm.length) review.push(`confirm step "${s.name}" ${confirm.join(' and ')}: it ${s.open}`);
  }
  return { violations: [...new Set(violations)].map(v => 'job contract: ' + v), report: { verified, review } };
}

/**
 * The contract a flow was composed under, checked against the graph about to
 * run. Null when no contract was stated. A contract that no longer validates
 * (the schedule's time zone changed) is reported, not thrown.
 */
export function recheckJobContract(trigger: FlowTriggerNode, stated: unknown): ContractReport & { violations: string[] } | null {
  if (stated === undefined || stated === null) return null;
  try {
    const { violations, report } = checkJobContract(trigger, validateJobContract(stated));
    return { ...report, violations };
  } catch (e) {
    if (e instanceof JobContractError) return { verified: [], review: [], violations: [e.message] };
    throw e;
  }
}
