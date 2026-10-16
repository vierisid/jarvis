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
 * pauses the flow until a person enables or publishes it again. Saving a draft
 * is an edit, not that acceptance, and the assistant cannot accept a change on
 * its own: manage_workflow asks a person first (`bindingChangesToAccept`).
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
/**
 * What a pin holds for one connection: its identity, or `unresolved` when the
 * flow named it but it did not resolve when pinned (the unattended startup
 * pass pins such flows too). Resolving later is a change like any other.
 */
export type PinnedConnection = ConnectionIdentity | { kind: 'unresolved' };
/** The computer a flow runs on: an enrolled sidecar, or this computer (`null`). */
export interface MachinePin { sidecarId: string | null; name: string }
export interface BindingPins {
  schemaVersion: 1;
  /** The version the pins were taken from. Pins apply to runs of that version only. */
  versionId: string;
  pinnedAt: number;
  connections: Record<string, PinnedConnection>;
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
/** A run's binding as the run API shows it: a managed grant's fingerprint is derived from its token, so it stays inside. */
export interface RunConnectionBindingView {
  externalId: string;
  identity: { kind: 'native'; connectionId: string; generation: number } | { kind: 'managed'; source: string } | null;
  boundAt: number;
  refusal?: { message: string; at: number };
}
/** Where a version names a connection. */
export interface ConnectionReference { node: string; path: string }

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

/**
 * Each connection a version names, the trigger included, with where it names
 * it. Any input counts, `auth` or not: readiness accepts a complete
 * `{{connections.id}}` binding in any of them and the engine resolves it
 * through the same credential route.
 */
export function connectionBindings(trigger: unknown): Map<string, ConnectionReference[]> {
  const bindings = new Map<string, ConnectionReference[]>();
  for (const node of walkFlowNodes(trigger as FlowTriggerNode)) {
    const pending: Array<[unknown, string]> = [[node.settings?.input, 'settings.input']];
    for (let visits = 0; pending.length && visits < 20_000; visits++) {
      const [value, path] = pending.pop()!;
      if (typeof value === 'string') {
        for (const [, expression] of value.matchAll(/\{\{(.*?)\}\}/g)) {
          const reference = CONNECTION_SOURCE.exec(expression!);
          const externalId = reference?.[1] ?? reference?.[2];
          if (externalId) bindings.set(externalId, [...bindings.get(externalId) ?? [], { node: node.name, path }]);
        }
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) pending.push([child, `${path}.${key}`]);
      }
    }
  }
  return bindings;
}

type Current = { identity: ConnectionIdentity } | { problem: 'missing' | 'ambiguous' | 'revoked' };
type Credentials = NonNullable<ReturnType<typeof workflowReadinessServices>>['credentials'];
/**
 * What a binding resolves to now, read without decrypting or refreshing
 * anything. A managed connection is identified by the resolver that hands it
 * out: the engine's credential route passes its own.
 */
export function currentConnectionIdentity(projectId: string, externalId: string, credentials: Credentials = workflowReadinessServices()?.credentials): Current {
  if (externalId.startsWith('jarvis:')) {
    const source = credentials?.list().find(candidate => candidate.canResolve(externalId));
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

/** What changed between what a binding was trusted with and the identity it resolves to now, or null. */
export function describeConnectionChange(externalId: string, before: PinnedConnection, after: ConnectionIdentity): string | null {
  if (before.kind === 'unresolved') {
    return after.kind === 'managed' ? `Connection ${externalId} was reconnected` : `Connection ${externalId} was created again`;
  }
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
 * Unattended (the startup pass, a saved draft), nobody is choosing a computer
 * and the ones that are connected say nothing about the one the flow has been
 * using. With several that could serve it the flow stays unpinned, and its
 * runs choose as before until a person enables it again. With one, that one is
 * pinned, so a run waits for it instead of falling back to this computer while
 * it sleeps, as runs did before pins.
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

/**
 * The computer for a saved draft of an enabled flow: the one already pinned
 * while it still fits the steps, including a pinned computer that is no longer
 * enrolled, which stays a blocker until a person enables the flow again. Steps
 * that name their computer, or pick it from run data, decide as they would at
 * enable; a pinned computer that no longer serves the steps, or none at all,
 * is chosen as at startup, never by which computer happens to be connected.
 */
function draftMachinePin(trigger: unknown, previous: MachinePin | null): MachinePin | null {
  const needs = machineNeeds(trigger);
  if (!needs.capability || needs.dynamic || needs.targets.length || !previous) return computeMachinePin(trigger, true);
  if (previous.sidecarId === null) return previous;
  const capability = needs.capability;
  const inventory = workflowReadinessServices()?.machines?.();
  const pinned = inventory?.find(s => s.id === previous.sidecarId);
  return !inventory || !pinned || pinned.capabilities?.includes(capability) ? previous : computeMachinePin(trigger, true);
}

export function readBindingPins(flowId: string): BindingPins | null {
  const row = getWorkflowDb().query<{ binding_pins: string | null }, [string]>('SELECT binding_pins FROM flow WHERE id = ?').get(flowId);
  if (!row?.binding_pins) return null;
  try {
    const pins = JSON.parse(row.binding_pins) as BindingPins;
    return pins?.schemaVersion === 1 ? pins : null;
  } catch { return null; }
}

function versionTrigger(versionId: string): unknown {
  const stored = getWorkflowDb().query<{ trigger: string }, [string]>('SELECT trigger FROM flow_version WHERE id = ?').get(versionId);
  try { return JSON.parse(stored?.trigger ?? 'null'); } catch { return null; }
}

/** The version an enabled flow runs: its published version, else its latest draft. */
function runningVersion(flowId: string): { projectId: string; versionId: string; trigger: unknown } | null {
  const row = getWorkflowDb().query<{ project_id: string; version_id: string | null }, [string]>(
    `SELECT f.project_id AS project_id, COALESCE(f.published_version_id, (SELECT id FROM flow_version WHERE flow_id = f.id AND state = 'DRAFT' ORDER BY updated DESC LIMIT 1)) AS version_id
       FROM flow f WHERE f.id = ?`,
  ).get(flowId);
  return row?.version_id ? { projectId: row.project_id, versionId: row.version_id, trigger: versionTrigger(row.version_id) } : null;
}

function pinnedNow(projectId: string, externalId: string): PinnedConnection {
  const current = currentConnectionIdentity(projectId, externalId);
  return 'identity' in current ? current.identity : { kind: 'unresolved' };
}

/** `updated` is not touched: pins are not an authoring change and must not reorder the workflows list. */
function writePins(flowId: string, pins: BindingPins): BindingPins {
  getWorkflowDb().run('UPDATE flow SET binding_pins = ? WHERE id = ?', [JSON.stringify(pins), flowId]);
  return pins;
}

/** Pin what a person just accepted by enabling or publishing: the bindings of the version the flow will run, as they resolve now. */
export function pinFlowBindings(flowId: string, { unattended = false }: { unattended?: boolean } = {}): BindingPins | null {
  const version = runningVersion(flowId);
  if (!version) return null;
  const connections: Record<string, PinnedConnection> = {};
  for (const externalId of connectionBindings(version.trigger).keys()) connections[externalId] = pinnedNow(version.projectId, externalId);
  return writePins(flowId, { schemaVersion: 1, versionId: version.versionId, pinnedAt: Date.now(), connections,
    machine: computeMachinePin(version.trigger, unattended) });
}

/**
 * An enabled flow with nothing published runs its latest draft. Saving that
 * draft is an edit, not a person accepting its bindings: what the pins already
 * hold stays, so a credential replaced since the flow was enabled is still a
 * blocker after any save. Only a connection no pin has named yet is pinned as
 * it resolves now, and the computer moves only when the steps no longer fit it
 * (`draftMachinePin`). A connection the draft stops naming keeps its pin, so
 * naming it again later cannot slip a changed credential through.
 */
export function repinLiveDraft(flowId: string): void {
  const flow = getWorkflowDb().query<{ status: string; published_version_id: string | null }, [string]>(
    'SELECT status, published_version_id FROM flow WHERE id = ?').get(flowId);
  if (flow?.status !== 'ENABLED' || flow.published_version_id) return;
  const previous = readBindingPins(flowId);
  if (!previous) { pinFlowBindings(flowId, { unattended: true }); return; }
  const version = runningVersion(flowId);
  if (!version) return;
  const connections = { ...previous.connections };
  for (const externalId of connectionBindings(version.trigger).keys()) connections[externalId] ??= pinnedNow(version.projectId, externalId);
  writePins(flowId, { schemaVersion: 1, versionId: version.versionId, pinnedAt: previous.pinnedAt, connections,
    machine: draftMachinePin(version.trigger, previous.machine) });
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

function flowProject(flowId: string): string | undefined {
  return getWorkflowDb().query<{ project_id: string }, [string]>('SELECT project_id FROM flow WHERE id = ?').get(flowId)?.project_id;
}

/**
 * Run-admission blockers: a pinned binding that now resolves to something
 * else. Missing, ambiguous and revoked connections are readiness's own
 * connection issues and are not repeated here.
 */
export function bindingPinIssues(flowId: string, versionId: string, trigger: unknown): ReadinessIssue[] {
  const pins = readBindingPins(flowId);
  if (!pins || pins.versionId !== versionId) return [];
  const projectId = flowProject(flowId);
  if (!projectId) return [];
  const issues: ReadinessIssue[] = [];
  for (const [externalId, references] of connectionBindings(trigger)) {
    const pinned = pins.connections[externalId];
    const current = pinned ? currentConnectionIdentity(projectId, externalId) : null;
    const change = pinned && current && 'identity' in current ? describeConnectionChange(externalId, pinned, current.identity) : null;
    if (change) issues.push({ node: references[0]!.node, path: references[0]!.path, code: 'BINDING_STALE', message: `${change} since this workflow was enabled. ${ACCEPT}` });
  }
  const machine = pins.machine;
  const inventory = machine?.sidecarId ? workflowReadinessServices()?.machines?.() : undefined;
  if (machine?.sidecarId && inventory && !inventory.some(s => s.id === machine.sidecarId)) {
    issues.push({ node: 'trigger', path: 'machine', code: 'BINDING_STALE',
      message: `The computer this workflow was enabled for (${machine.name}) is no longer enrolled. Enable or publish the workflow again to choose a computer.` });
  }
  return issues;
}

/**
 * What enabling or publishing `versionId` now would accept that differs from
 * what a person last accepted: each pinned connection that resolves to another
 * identity, and the computer when the choice would change. Empty when nothing
 * was accepted yet. manage_workflow shows these to a person, who approves
 * before the assistant enables or publishes; the dashboard is the person.
 */
export function bindingChangesToAccept(flowId: string, versionId: string): string[] {
  const pins = readBindingPins(flowId);
  const projectId = flowProject(flowId);
  if (!pins || !projectId) return [];
  const trigger = versionTrigger(versionId);
  const changes: string[] = [];
  for (const externalId of connectionBindings(trigger).keys()) {
    const pinned = pins.connections[externalId];
    const current = pinned ? currentConnectionIdentity(projectId, externalId) : null;
    const change = pinned && current && 'identity' in current ? describeConnectionChange(externalId, pinned, current.identity) : null;
    if (change) changes.push(`${change}; it may now act as a different account.`);
  }
  if (pins.machine) {
    const next = computeMachinePin(trigger, false);
    if (!next || next.sidecarId !== pins.machine.sidecarId) {
      changes.push(`The computer it runs on changes from ${pins.machine.name} to ${next?.name ?? 'whichever computer each run picks'}.`);
    }
  }
  return changes;
}

/** The computer pinned for this run's version, or undefined when the run is not pinned to one. */
export function machinePinForRun(runId: string): MachinePin | undefined {
  const run = getWorkflowDb().query<{ flow_id: string; flow_version_id: string }, [string]>(
    'SELECT flow_id, flow_version_id FROM flow_run WHERE id = ?').get(runId);
  if (!run) return undefined;
  const pins = readBindingPins(run.flow_id);
  return pins?.versionId === run.flow_version_id ? pins.machine ?? undefined : undefined;
}

function runBinding(runId: string, externalId: string): RunConnectionBinding | null {
  const row = getWorkflowDb().query<{ record: string }, [string, string]>(
    'SELECT record FROM workflow_run_connection_binding WHERE run_id = ? AND external_id = ?').get(runId, externalId);
  return row ? JSON.parse(row.record) as RunConnectionBinding : null;
}

/**
 * The engine asks for a connection's credential at every step, retry and
 * resume, after the resolver has found it. The first fetch in a run binds the
 * identity, checked against the flow's pins; every later fetch must resolve to
 * the same identity. Returns the refusal to send back instead of the
 * credential, and records it on the run so it stays inspectable; null when the
 * credential may be handed out. A connection that no longer identifies as
 * anything by now (removed, or revoked) is refused too: the resolver's answer
 * is already stale. Two rows under one id are told apart by the resolver's
 * piece name and left to it.
 */
export function enforceRunConnectionBinding(runId: string, projectId: string, externalId: string, credentials?: Credentials): string | null {
  const db = getWorkflowDb();
  const run = db.query<{ flow_id: string; flow_version_id: string; project_id: string }, [string]>(
    'SELECT flow_id, flow_version_id, project_id FROM flow_run WHERE id = ?').get(runId);
  if (!run || run.project_id !== projectId) return null;
  // Most fetches come from a later step of a run already bound to this
  // identity: answer those without taking the write lock.
  const early = runBinding(runId, externalId);
  const now = currentConnectionIdentity(projectId, externalId, credentials);
  if (early?.identity && !early.refusal && 'identity' in now && !describeConnectionChange(externalId, early.identity, now.identity)) return null;
  return db.transaction((): string | null => {
    const current = currentConnectionIdentity(projectId, externalId, credentials);
    const bound = runBinding(runId, externalId);
    const refuse = (message: string): string => {
      const record: RunConnectionBinding = { ...(bound ?? { externalId, identity: null, boundAt: Date.now() }), refusal: { message, at: Date.now() } };
      db.run(`INSERT INTO workflow_run_connection_binding (run_id, external_id, record) VALUES (?, ?, ?)
        ON CONFLICT(run_id, external_id) DO UPDATE SET record = excluded.record`, [runId, externalId, JSON.stringify(record)]);
      return message;
    };
    if (bound?.refusal) return bound.refusal.message;
    if (!('identity' in current)) {
      if (current.problem === 'ambiguous') return null;
      return refuse(`Connection ${externalId} was ${current.problem === 'revoked' ? 'revoked' : 'removed'} while this run asked for it. `
        + 'Its credential was not handed out; start a new run once the connection is right.');
    }
    if (bound) {
      const change = bound.identity ? describeConnectionChange(externalId, bound.identity, current.identity) : null;
      return change ? refuse(`${change} during this run, after the run first used it. Its credential was not handed out; start a new run once the connection is right.`) : null;
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

/** A run's bindings for the run API: which connection, what kind, and any refusal, without a grant fingerprint. */
export function runConnectionBindingViews(runId: string): RunConnectionBindingView[] {
  return listRunConnectionBindings(runId).map(({ externalId, identity, boundAt, refusal }) => ({
    externalId, boundAt, ...(refusal ? { refusal } : {}),
    identity: identity?.kind === 'managed' ? { kind: 'managed', source: identity.source } : identity,
  }));
}
