/**
 * Q-05: the bindings a workflow was enabled against, and the checks that stop
 * work when one of them changes.
 *
 * When a person publishes or enables a flow, the connections its steps name
 * and the computer it runs on are pinned: each connection's identity (the
 * stored row and how many times its credential was replaced, or a managed
 * source's grant fingerprint) and one computer. Run admission, the engine's
 * connection fetch and the run's machine binding compare against the pins. A
 * change is a typed blocker that names what changed and how to accept it;
 * nothing substitutes another account or computer.
 *
 * Jarvis keeps no account identity for a connection, so a rotated key cannot
 * be told from another account under the same name: any credential change
 * pauses the flow until a person enables or publishes it again.
 */
import { getWorkflowDb } from '../index';
import { walkFlowNodes } from '../flow-graph';
import type { FlowTriggerNode } from './flow-version';
import { CONNECTION_SOURCE, type ReadinessIssue } from '../../runtime/workflow-readiness';
import { BOUNDED_TOOLS, boundedToolCapability } from '../../runtime/tool-capability';
import { workflowReadinessServices } from './readiness-services';
import type { SidecarCapability, SidecarInfo } from '../../../sidecar/types';
import { servesCapability } from '../../../sidecar/capability-predicate';

/** Which credential a binding resolves to: never the credential itself. */
export type ConnectionIdentity =
  | { kind: 'native'; connectionId: string; generation: number }
  | { kind: 'managed'; source: string; grant: string };
/** The computer a flow runs on: an enrolled sidecar, or this computer (`null`). */
export interface MachinePin { sidecarId: string | null; name: string }
export interface BindingPins {
  schemaVersion: 1;
  /** The version the pins were taken from. Pins apply to runs of that version only. */
  versionId: string;
  pinnedAt: number;
  connections: Record<string, ConnectionIdentity>;
  /** Null when no computer could be fixed: no machine steps, or the flow picks its target from run data. */
  machine: MachinePin | null;
}
export interface RunConnectionBinding {
  externalId: string;
  identity: ConnectionIdentity | null;
  boundAt: number;
  /** Set when the run asked for a credential that no longer matched; the fetch was refused. */
  refusal?: { message: string; at: number };
}

const ACCEPT = 'It may now act as a different account. Check the connection, then enable or publish the workflow again to accept it.';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isExpression = (value: unknown) => typeof value === 'string' && value.includes('{{');
const isJarvisTool = (pieceName: string) => pieceName === 'jarvis-tool' || pieceName.endsWith('/piece-jarvis-tool');
function paramsOf(input: Record<string, unknown>): Record<string, unknown> {
  if (object(input.params)) return input.params;
  if (typeof input.params === 'string') {
    try { const parsed = JSON.parse(input.params); if (object(parsed)) return parsed; } catch { /* not JSON */ }
  }
  return {};
}

/** Each connection a step's `auth` names, with the steps that name it. The trigger counts. */
export function connectionBindings(trigger: unknown): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  for (const node of walkFlowNodes(trigger as FlowTriggerNode)) {
    const auth = object(node.settings?.input) ? node.settings!.input.auth : undefined;
    if (typeof auth !== 'string') continue;
    const inner = /^\{\{(.*)\}\}$/.exec(auth.trim())?.[1];
    const match = inner ? CONNECTION_SOURCE.exec(inner) : null;
    const externalId = match?.[1] ?? match?.[2];
    if (externalId) bindings.set(externalId, [...bindings.get(externalId) ?? [], node.name]);
  }
  return bindings;
}

type Current = { identity: ConnectionIdentity } | { problem: 'missing' | 'ambiguous' | 'revoked' };
/** What a binding resolves to now, read without decrypting or refreshing anything. */
export function currentConnectionIdentity(projectId: string, externalId: string): Current {
  if (externalId.startsWith('jarvis:')) {
    const source = workflowReadinessServices()?.credentials?.list().find(candidate => candidate.canResolve(externalId));
    if (!source) return { problem: 'missing' };
    const grant = source.identity ? source.identity(externalId) : `source:${source.id}`;
    return grant === null ? { problem: 'revoked' } : { identity: { kind: 'managed', source: source.id, grant } };
  }
  const rows = getWorkflowDb().query<{ id: string; credential_generation: number }, [string, string]>(
    'SELECT id, credential_generation FROM app_connection WHERE project_id = ? AND external_id = ? LIMIT 2',
  ).all(projectId, externalId);
  if (rows.length !== 1) return { problem: rows.length ? 'ambiguous' : 'missing' };
  return { identity: { kind: 'native', connectionId: rows[0]!.id, generation: rows[0]!.credential_generation } };
}

/** What changed between the identity a binding was trusted with and the one it resolves to now, or null. */
export function describeConnectionChange(externalId: string, before: ConnectionIdentity, after: ConnectionIdentity): string | null {
  if (before.kind === 'native' && after.kind === 'native') {
    if (before.connectionId !== after.connectionId) return `Connection ${externalId} was deleted and created again`;
    return before.generation === after.generation ? null : `The credential stored in connection ${externalId} was replaced`;
  }
  if (before.kind === 'managed' && after.kind === 'managed') {
    return before.source === after.source && before.grant === after.grant ? null : `Connection ${externalId} was reconnected`;
  }
  return `Connection ${externalId} now resolves to a different kind of credential`;
}

/** The computers a flow's steps need: the first machine step's capability, literal targets, and whether run data picks the target. */
function machineNeeds(trigger: unknown): { capability: SidecarCapability | null; targets: string[]; dynamic: boolean } {
  let capability: SidecarCapability | null = null, dynamic = false;
  const targets: string[] = [];
  for (const node of walkFlowNodes(trigger as FlowTriggerNode).slice(1)) {
    if (node.type !== 'PIECE' || !isJarvisTool(String(node.settings?.pieceName ?? ''))) continue;
    const input = object(node.settings?.input) ? node.settings!.input : {};
    const toolName = input.toolName;
    if (typeof toolName !== 'string' || isExpression(toolName)) { dynamic = true; continue; }
    if (!BOUNDED_TOOLS.has(toolName) && toolName !== 'run_skill') continue;
    // A skill's surface is known only when it runs; a desktop-capable computer serves either.
    capability ??= toolName === 'run_skill' ? 'desktop' : boundedToolCapability(toolName);
    const target = paramsOf(input).target;
    if (typeof target === 'string' && target.trim()) {
      if (isExpression(target)) dynamic = true;
      else targets.push(target.trim());
    }
  }
  return { capability, targets, dynamic };
}

/** An enrolled computer by exact id, or the only one with exactly this name. Never a partial match. */
function exactMachine(selector: string, inventory: SidecarInfo[]): SidecarInfo | null {
  const byId = inventory.find(s => s.id === selector);
  if (byId) return byId;
  const named = inventory.filter(s => s.name.toLowerCase() === selector.toLowerCase());
  return named.length === 1 ? named[0]! : null;
}

/**
 * The computer a run would choose today, chosen once. A literal target that
 * names one enrolled computer exactly pins it. Otherwise the most recently
 * enrolled computer serving the first machine step's capability, preferring
 * one that is connected, so a laptop asleep at publish time is still the one
 * pinned rather than this computer; this computer only when no enrolled one
 * serves the capability. A target picked from run data, a partial name and
 * conflicting targets stay unpinned, as before.
 *
 * Unattended (the startup pass), nobody is choosing and computers may not have
 * reconnected yet, so which one is connected says nothing about the computer
 * the flow has been using. With several that could serve it, the flow stays
 * unpinned and its runs choose as before, until a person enables it again.
 */
function computeMachinePin(trigger: unknown, unattended: boolean): MachinePin | null {
  const services = workflowReadinessServices();
  const inventory = services?.machines?.();
  if (!inventory) return null;
  const needs = machineNeeds(trigger);
  if (!needs.capability || needs.dynamic) return null;
  if (needs.targets.length) {
    const named = needs.targets.map(target => exactMachine(target, inventory));
    return named[0] && named.every(machine => machine?.id === named[0]!.id) ? { sidecarId: named[0].id, name: named[0].name } : null;
  }
  const capability = needs.capability;
  const serving = inventory.filter(s => s.capabilities?.includes(capability));
  if (unattended && serving.length > 1) return null;
  const chosen = serving.find(s => servesCapability(s, capability)) ?? serving[0];
  if (chosen) return { sidecarId: chosen.id, name: chosen.name };
  return services?.localTools?.() === false ? null : { sidecarId: null, name: 'this computer' };
}

export function readBindingPins(flowId: string): BindingPins | null {
  const row = getWorkflowDb().query<{ binding_pins: string | null }, [string]>('SELECT binding_pins FROM flow WHERE id = ?').get(flowId);
  if (!row?.binding_pins) return null;
  try {
    const pins = JSON.parse(row.binding_pins) as BindingPins;
    return pins?.schemaVersion === 1 ? pins : null;
  } catch { return null; }
}

/**
 * Pin what a person just accepted by enabling or publishing: the bindings of
 * the version the flow will run. `updated` is not touched; pins are not an
 * authoring change and must not reorder the workflows list.
 */
export function pinFlowBindings(flowId: string, { unattended = false }: { unattended?: boolean } = {}): BindingPins | null {
  const db = getWorkflowDb();
  const row = db.query<{ project_id: string; version_id: string | null }, [string]>(
    `SELECT f.project_id AS project_id, COALESCE(f.published_version_id, (SELECT id FROM flow_version WHERE flow_id = f.id AND state = 'DRAFT' ORDER BY updated DESC LIMIT 1)) AS version_id
       FROM flow f WHERE f.id = ?`,
  ).get(flowId);
  if (!row?.version_id) return null;
  const stored = db.query<{ trigger: string }, [string]>('SELECT trigger FROM flow_version WHERE id = ?').get(row.version_id);
  let trigger: unknown = null;
  try { trigger = JSON.parse(stored?.trigger ?? 'null'); } catch { trigger = null; }
  const connections: Record<string, ConnectionIdentity> = {};
  for (const externalId of connectionBindings(trigger).keys()) {
    const current = currentConnectionIdentity(row.project_id, externalId);
    if ('identity' in current) connections[externalId] = current.identity;
  }
  const pins: BindingPins = { schemaVersion: 1, versionId: row.version_id, pinnedAt: Date.now(), connections, machine: computeMachinePin(trigger, unattended) };
  db.run('UPDATE flow SET binding_pins = ? WHERE id = ?', [JSON.stringify(pins), flowId]);
  return pins;
}

/**
 * An enabled flow with nothing published runs its latest draft, so editing or
 * adding that draft is the person changing what runs: pin it again.
 */
export function repinLiveDraft(flowId: string): void {
  const flow = getWorkflowDb().query<{ status: string; published_version_id: string | null }, [string]>(
    'SELECT status, published_version_id FROM flow WHERE id = ?').get(flowId);
  if (flow?.status === 'ENABLED' && !flow.published_version_id) pinFlowBindings(flowId);
}

/**
 * Pin every enabled flow that has no pins yet. On upgrade, the bindings an
 * enabled flow runs against now are the ones it was enabled with.
 */
export function pinUnpinnedEnabledFlows(): number {
  const flows = getWorkflowDb().query<{ id: string }, []>("SELECT id FROM flow WHERE status = 'ENABLED' AND binding_pins IS NULL").all();
  let pinned = 0;
  for (const { id } of flows) {
    try { if (pinFlowBindings(id, { unattended: true })) pinned++; }
    catch (error) { console.warn(`[binding-pins] could not pin flow ${id}: ${(error as Error).message}`); }
  }
  return pinned;
}

/**
 * Run-admission blockers: a pinned binding that now resolves to something
 * else. Missing, ambiguous and revoked connections are readiness's own
 * connection issues and are not repeated here.
 */
export function bindingPinIssues(flowId: string, versionId: string, trigger: unknown): ReadinessIssue[] {
  const pins = readBindingPins(flowId);
  if (!pins || pins.versionId !== versionId) return [];
  const projectId = getWorkflowDb().query<{ project_id: string }, [string]>('SELECT project_id FROM flow WHERE id = ?').get(flowId)?.project_id;
  if (!projectId) return [];
  const issues: ReadinessIssue[] = [];
  for (const [externalId, steps] of connectionBindings(trigger)) {
    const pinned = pins.connections[externalId];
    const current = pinned ? currentConnectionIdentity(projectId, externalId) : null;
    const change = pinned && current && 'identity' in current ? describeConnectionChange(externalId, pinned, current.identity) : null;
    if (change) issues.push({ node: steps[0]!, path: 'settings.input.auth', code: 'BINDING_STALE', message: `${change} since this workflow was enabled. ${ACCEPT}` });
  }
  const machine = pins.machine;
  const inventory = machine?.sidecarId ? workflowReadinessServices()?.machines?.() : undefined;
  if (machine?.sidecarId && inventory && !inventory.some(s => s.id === machine.sidecarId)) {
    issues.push({ node: 'trigger', path: 'machine', code: 'BINDING_STALE',
      message: `The computer this workflow was enabled for (${machine.name}) is no longer enrolled. Enable or publish the workflow again to choose a computer.` });
  }
  return issues;
}

/** The computer pinned for this run's version, or undefined when the run is not pinned to one. */
export function machinePinForRun(runId: string): MachinePin | undefined {
  const run = getWorkflowDb().query<{ flow_id: string; flow_version_id: string }, [string]>(
    'SELECT flow_id, flow_version_id FROM flow_run WHERE id = ?').get(runId);
  if (!run) return undefined;
  const pins = readBindingPins(run.flow_id);
  return pins?.versionId === run.flow_version_id ? pins.machine ?? undefined : undefined;
}

/**
 * The engine asks for a connection's credential at every step, retry and
 * resume. The first fetch in a run binds the identity, checked against the
 * flow's pins; every later fetch must resolve to the same identity. Returns
 * the refusal to send back instead of the credential, and records it on the
 * run so it stays inspectable; null when the credential may be handed out.
 * A missing, ambiguous or revoked connection is left to the resolver's own
 * refusal.
 */
export function enforceRunConnectionBinding(runId: string, projectId: string, externalId: string): string | null {
  const db = getWorkflowDb();
  const run = db.query<{ flow_id: string; flow_version_id: string; project_id: string }, [string]>(
    'SELECT flow_id, flow_version_id, project_id FROM flow_run WHERE id = ?').get(runId);
  if (!run || run.project_id !== projectId) return null;
  return db.transaction((): string | null => {
    const current = currentConnectionIdentity(projectId, externalId);
    if (!('identity' in current)) return null;
    const row = db.query<{ record: string }, [string, string]>(
      'SELECT record FROM workflow_run_connection_binding WHERE run_id = ? AND external_id = ?').get(runId, externalId);
    const refuse = (message: string, bound?: RunConnectionBinding): string => {
      const record: RunConnectionBinding = { ...(bound ?? { externalId, identity: null, boundAt: Date.now() }), refusal: { message, at: Date.now() } };
      db.run(`INSERT INTO workflow_run_connection_binding (run_id, external_id, record) VALUES (?, ?, ?)
        ON CONFLICT(run_id, external_id) DO UPDATE SET record = excluded.record`, [runId, externalId, JSON.stringify(record)]);
      return message;
    };
    if (row) {
      const bound = JSON.parse(row.record) as RunConnectionBinding;
      if (bound.refusal) return bound.refusal.message;
      const change = bound.identity ? describeConnectionChange(externalId, bound.identity, current.identity) : null;
      return change ? refuse(`${change} during this run, after the run first used it. Its credential was not handed out; start a new run once the connection is right.`, bound) : null;
    }
    const pins = readBindingPins(run.flow_id);
    const pinned = pins?.versionId === run.flow_version_id ? pins.connections[externalId] : undefined;
    const change = pinned ? describeConnectionChange(externalId, pinned, current.identity) : null;
    if (change) return refuse(`${change} since this workflow was enabled. ${ACCEPT}`);
    db.run('INSERT INTO workflow_run_connection_binding (run_id, external_id, record) VALUES (?, ?, ?)',
      [runId, externalId, JSON.stringify({ externalId, identity: current.identity, boundAt: Date.now() } satisfies RunConnectionBinding)]);
    return null;
  }).immediate();
}

export function listRunConnectionBindings(runId: string): RunConnectionBinding[] {
  return getWorkflowDb().query<{ record: string }, [string]>(
    'SELECT record FROM workflow_run_connection_binding WHERE run_id = ? ORDER BY external_id').all(runId)
    .map(row => JSON.parse(row.record) as RunConnectionBinding);
}
