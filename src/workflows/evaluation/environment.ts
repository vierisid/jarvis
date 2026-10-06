import type { ComposerLibraryEntry, ComposerSpecialistRole, ComposerToolSpec } from '../../actions/tools/workflow-composer';
import { discoverSpecialists } from '../../agents/role-discovery';
import { CATALOG } from '../pieces-library/catalog';
import type { ToolDefinition } from '../../actions/tools/registry';
import type { ExecutionTarget } from '../../util/execution-environment';
import type { PieceCatalogEntry } from '../runtime/piece-catalog';
import {
  captureScreenTool, getClipboardTool, listDirectoryTool, readFileTool, setClipboardTool, writeFileTool,
} from '../../actions/tools/builtin';
import { desktopSnapshotTool } from '../../actions/tools/desktop';

/**
 * Everything the composer is shown besides the job: which Jarvis pieces are
 * installed, which tools a workflow may invoke, which machines exist, and
 * which connection-bound integrations are installed. A task set names its
 * environment, so a task is always graded against what it was written for.
 */
export interface EvaluationEnvironment {
  id: string;
  /** Jarvis pieces whose real metadata the engine extracts, and which run here. */
  jarvisPieces: string[];
  /** Connection-bound integrations shown to the composer but never executed: graded on the graph. */
  external: PieceCatalogEntry[];
  tools: ComposerToolSpec[];
  targets: ExecutionTarget[];
  /** Specialist roles production lists for delegation. Absent in the original envelopes. */
  specialistRoles?: ComposerSpecialistRole[];
  /** Installable pieces production offers; self-hosted daemons show them, hosted ones manage pieces themselves. */
  library?: ComposerLibraryEntry[];
}

/** The same projection the daemon gives the composer (daemon/index.ts, composerToolRegistry.listDetailed). */
export function composerToolSpec(tool: ToolDefinition): ComposerToolSpec {
  return { name: tool.name, description: tool.description,
    params: Object.entries(tool.parameters).map(([name, p]) => ({ name, type: p.type, required: p.required, description: p.description, enum: p.enum })) };
}

const field = (name: string, label: string, type: 'string' | 'long_text' | 'json' | 'boolean' | 'enum', required: boolean, description: string) =>
  ({ name, label, type, required, description });
const oauth = (description: string) => ({ type: 'OAUTH2', description });

/** Metadata-only entries using the action and property names of the catalog's
 * verified versions (gmail 0.17.0, slack 0.21.0). A step on these pieces is
 * checked for its action, connection binding and literal inputs; it never runs. */
export const EXTERNAL_FIXTURES: PieceCatalogEntry[] = [
  { name: '@activepieces/piece-gmail', displayName: 'Gmail', description: 'Send and draft email through a connected Gmail account.',
    auth: oauth('Gmail connection') as any, actions: {
      gmail_create_draft: { name: 'gmail_create_draft', displayName: 'Create draft', requireAuth: true,
        description: 'Create a draft email in Gmail without sending it.',
        inputSchema: { fields: [field('receiver', 'Receiver email', 'json', true, 'Array of recipient email addresses'),
          field('subject', 'Subject', 'string', true, 'Email subject'), field('body', 'Body', 'long_text', true, 'Email body'),
          field('cc', 'CC', 'json', false, 'Array of CC addresses'), field('bcc', 'BCC', 'json', false, 'Array of BCC addresses')] } as any },
      send_email: { name: 'send_email', displayName: 'Send email', requireAuth: true,
        description: 'Send an email through Gmail immediately.',
        inputSchema: { fields: [field('receiver', 'Receiver email', 'json', true, 'Array of recipient email addresses'),
          field('subject', 'Subject', 'string', true, 'Email subject'), field('body', 'Body', 'long_text', true, 'Email body'),
          field('cc', 'CC', 'json', false, 'Array of CC addresses'), field('bcc', 'BCC', 'json', false, 'Array of BCC addresses')] } as any },
    } },
  { name: '@activepieces/piece-slack', displayName: 'Slack', description: 'Post messages to a connected Slack workspace.',
    auth: oauth('Slack connection') as any, actions: {
      send_channel_message: { name: 'send_channel_message', displayName: 'Send message to a channel', requireAuth: true,
        description: 'Post a message to a Slack channel by channel id.',
        inputSchema: { fields: [field('channel', 'Channel', 'string', true, 'Channel id, for example C0123456'),
          field('text', 'Message', 'long_text', true, 'Message text')] } as any },
      send_direct_message: { name: 'send_direct_message', displayName: 'Send direct message', requireAuth: true,
        description: 'Send a direct message to a Slack user by user id.',
        inputSchema: { fields: [field('userId', 'User', 'string', true, 'Slack user id, for example U0123456'),
          field('text', 'Message', 'long_text', true, 'Message text')] } as any },
    } },
];

/** Workflow-invocable tools only: the bounded file, clipboard and screen tools a
 * flow can run under Authority (effect-capabilities.ts BOUNDED_TOOLS). */
const FOUNDER_TOOLS = [readFileTool, writeFileTool, listDirectoryTool, getClipboardTool, setClipboardTool,
  captureScreenTool, desktopSnapshotTool].map(composerToolSpec);

const FOUNDER_TARGETS: ExecutionTarget[] = [
  { id: '', name: 'This computer', os: 'darwin', arch: 'arm64', connected: true, isHost: true, capabilities: ['filesystem', 'clipboard', 'screen', 'desktop'] },
  { id: 'sidecar-office', name: 'Office Mac', os: 'darwin', arch: 'arm64', connected: true, capabilities: ['filesystem', 'screen', 'desktop'] },
  { id: 'sidecar-studio', name: 'Studio PC', os: 'windows', arch: 'amd64', connected: false, capabilities: ['filesystem', 'screen', 'desktop'] },
];

export const ENVIRONMENTS: Record<string, EvaluationEnvironment> = {
  // The original W8 envelope, unchanged, so earlier results stay comparable.
  'w8': { id: 'w8', jarvisPieces: ['notify', 'regex', 'ask', 'trigger'], external: [], tools: [], targets: [] },
  'founder-v1': { id: 'founder-v1', jarvisPieces: ['notify', 'regex', 'ask', 'trigger', 'context', 'tool', 'agent'],
    external: EXTERNAL_FIXTURES, tools: FOUNDER_TOOLS, targets: FOUNDER_TARGETS },
};

/** The shipped specialist roles, mapped as the daemon maps them for the composer (daemon/index.ts). */
function shippedRoles(): ComposerSpecialistRole[] {
  return [...discoverSpecialists('roles/specialists').values()].map(r => ({ id: r.id, name: r.name, description: r.description }));
}
/** The pieces library, mapped as a self-hosted daemon offers it (daemon/index.ts composerLibrary). */
function shippedLibrary(): ComposerLibraryEntry[] {
  return CATALOG.map(e => ({ id: e.id, npmPackage: e.npmPackage, displayName: e.displayName, description: e.description }));
}
/**
 * founder-v1 as production shows it to the composer: with the shipped
 * specialist roles, and on a self-hosted daemon the pieces library (hosted
 * installs manage pieces and show none). Built on first use, so loading this
 * module reads no role files. Run a founder task set in one with --environment.
 */
const PRODUCTION_SHAPES: Record<string, () => EvaluationEnvironment> = {
  'founder-v2': () => ({ ...ENVIRONMENTS['founder-v1']!, id: 'founder-v2', specialistRoles: shippedRoles(), library: shippedLibrary() }),
  'founder-v2-hosted': () => ({ ...ENVIRONMENTS['founder-v1']!, id: 'founder-v2-hosted', specialistRoles: shippedRoles() }),
};
const built = new Map<string, EvaluationEnvironment>();

/** Whether the composer sees what production shows it: at least the specialist roles every daemon lists. */
export const productionShaped = (environment: EvaluationEnvironment) => (environment.specialistRoles?.length ?? 0) > 0;

/** Whether `outer` offers everything `inner` does, so a task written for `inner` can run in `outer`. */
export function extendsEnvironment(outer: EvaluationEnvironment, inner: EvaluationEnvironment): boolean {
  const covers = (a: string[], b: string[]) => b.every(x => a.includes(x));
  return covers(outer.jarvisPieces, inner.jarvisPieces) && covers(outer.external.map(e => e.name), inner.external.map(e => e.name))
    && covers(outer.tools.map(t => t.name), inner.tools.map(t => t.name))
    && covers(outer.targets.map(t => t.id + '\0' + t.name), inner.targets.map(t => t.id + '\0' + t.name));
}

/** What the composer is given besides the catalog, exactly as production passes it. */
export function composerEnvironment(environment: EvaluationEnvironment) {
  return {
    ...(environment.tools.length ? { tools: environment.tools } : {}),
    ...(environment.targets.length ? { executionTargets: environment.targets } : {}),
    ...(environment.specialistRoles?.length ? { specialistRoles: environment.specialistRoles } : {}),
    ...(environment.library?.length ? { library: environment.library } : {}),
  };
}

/** A machine may be named by display name or sidecar id; both mean the same target. */
export function canonicalTarget(target: unknown): unknown {
  for (const environment of Object.values(ENVIRONMENTS))
    for (const t of environment.targets) if (t.id !== '' && t.id === target) return t.name;
  return target;
}
/** Tool parameters with the target written as its display name. */
export function canonicalToolParams(params: Record<string, unknown>): Record<string, unknown> {
  return 'target' in params ? { ...params, target: canonicalTarget(params.target) } : params;
}

export function environmentFor(id: string | undefined): EvaluationEnvironment {
  const key = id ?? 'w8';
  const shape = PRODUCTION_SHAPES[key];
  if (shape && !built.has(key)) built.set(key, shape());
  const environment = ENVIRONMENTS[key] ?? built.get(key);
  if (!environment) throw new Error('Unknown evaluation environment ' + id);
  return environment;
}
