import { createHash } from 'node:crypto';
import { getWorkflowDb } from '../../workflows/db';
import { getFlowInProject } from '../../workflows/db/repos/flow';
import { getFlowVersion, getLatestDraft, updateDraftVersion, type FlowVersion, type FlowTriggerNode } from '../../workflows/db/repos/flow-version';
import { workflowRemovalState } from '../../workflows/db/repos/workflow-removal-state';
import { compileWorkflow, type ReadinessContext } from '../../workflows/runtime/workflow-readiness';

/** Covers the persisted authoring snapshot, not a recomputed readiness report. */
export function draftRevision(version: FlowVersion): string {
  return createHash('sha256').update(JSON.stringify(version)).digest('hex');
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: unknown, key: string) => (object(value) || Array.isArray(value)) && Object.hasOwn(value, key);
function fail(message: string): never { throw new Error('update: ' + message); }

/** Bounded JSON Patch subset. Paths address only the trigger graph; untouched
 * inputs and node identities survive verbatim. No prototype traversal or eval. */
export function patchDraftGraph(saved: FlowTriggerNode, patches: unknown): FlowTriggerNode {
  if (!Array.isArray(patches) || patches.length > 64) fail('patches must be an array of at most 64 operations');
  if (JSON.stringify(patches).length > 256_000) fail('patches exceed 256 KB');
  let graph: any = structuredClone(saved);
  for (const patch of patches) {
    if (!object(patch) || !['add', 'replace', 'remove'].includes(patch.op) || typeof patch.path !== 'string'
      || Object.keys(patch).some(key => !['op', 'path', 'value'].includes(key))) fail('expected {op:add|replace|remove,path,value?}');
    if (patch.op !== 'remove' && !Object.hasOwn(patch, 'value')) fail('add/replace requires value (null is allowed)');
    if (patch.op === 'remove' && Object.hasOwn(patch, 'value')) fail('remove must not include value');
    const path = patch.path;
    if (path === '') {
      if (patch.op !== 'replace' || !object(patch.value)) fail('the graph root supports only replace with an object');
      graph = structuredClone(patch.value);
      continue;
    }
    if (!path.startsWith('/') || path.length > 4096 || /~(?![01])/.test(path)) fail('path must be a JSON Pointer into the trigger graph');
    const keys = path.slice(1).split('/').map((key: string) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (keys.length > 64 || keys.some((key: string) => ['__proto__', 'prototype', 'constructor'].includes(key))) fail('unsafe or excessively deep path');
    let parent = graph;
    for (const key of keys.slice(0, -1)) {
      if (!own(parent, key)) fail('path parent does not exist');
      parent = parent[key];
    }
    const key = keys.at(-1)!;
    if (Array.isArray(parent)) {
      const index = key === '-' && patch.op === 'add' ? parent.length : /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
      if (!Number.isSafeInteger(index) || index < 0 || index > parent.length || (patch.op !== 'add' && index === parent.length)) fail('array index is out of range');
      if (patch.op === 'remove') parent.splice(index, 1);
      else if (patch.op === 'add') parent.splice(index, 0, structuredClone(patch.value));
      else parent[index] = structuredClone(patch.value);
    } else if (object(parent)) {
      if (patch.op !== 'add' && !own(parent, key)) fail('replace/remove path does not exist');
      if (patch.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(patch.value);
    } else fail('path parent must be an object or array');
  }
  if (JSON.stringify(graph).length > 4_000_000) fail('edited graph exceeds 4 MB');
  return graph;
}

/** Synchronous check + validation + write in one SQLite transaction. No LLM,
 * network, installation, activation, run, or workflow/version creation. */
export function updateSavedDraft(input: {
  projectId: string; flowId: string; versionId: string; expectedRevision: string;
  patches: unknown; name?: unknown; context: ReadinessContext;
  validateContract?: (graph: FlowTriggerNode) => void;
}): { version: FlowVersion; changed: boolean } {
  return getWorkflowDb().transaction(() => {
    const flow = getFlowInProject(input.projectId, input.flowId);
    if (!flow || workflowRemovalState(flow.id).receipt_id) fail('workflow not found');
    const version = getFlowVersion(input.versionId);
    if (!version || version.flowId !== flow.id) fail('version not found in this workflow');
    if (version.state !== 'DRAFT') fail('published/LOCKED versions cannot be edited; select an editable draft');
    if (getLatestDraft(flow.id)?.id !== version.id) fail('draft selection changed; read the selected draft again');
    if (flow.status === 'ENABLED' && !flow.published_version_id) fail('this unpublished draft is live; disable the workflow before editing');
    if (!/^[a-f0-9]{64}$/.test(input.expectedRevision) || draftRevision(version) !== input.expectedRevision) fail('draft changed since readback; get the definition again before editing');
    if (!input.context.pieces) fail('installed action schemas are unavailable');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200)) fail('name must be a nonempty string of at most 200 characters');
    const graph = patchDraftGraph(version.trigger, input.patches);
    const validation = compileWorkflow(graph, { ...input.context, phase: 'composition' });
    if (!validation.ready) fail('edited graph is invalid: ' + validation.issues.slice(0, 5).map(i => `${i.node} (${i.path}): ${i.message}`).join('; '));
    input.validateContract?.(graph);
    const changed = JSON.stringify(graph) !== JSON.stringify(version.trigger) || input.name !== undefined && input.name !== version.displayName;
    if (!changed) return { version, changed: false };
    return { version: updateDraftVersion(version.id, { trigger: graph, ...(typeof input.name === 'string' ? { displayName: input.name } : {}) }), changed: true };
  }).immediate();
}
