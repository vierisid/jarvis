import type { ComposerToolSpec } from '../../actions/tools/workflow-composer';
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
  const environment = ENVIRONMENTS[id ?? 'w8'];
  if (!environment) throw new Error('Unknown evaluation environment ' + id);
  return environment;
}
