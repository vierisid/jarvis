import { createHash } from 'node:crypto';
import type { FlowVersion } from '../db/repos/flow-version';
import { getFlowVersionUiMeta } from '../db/repos/flow-version-ui-meta';

/** Authoring content and layout share a revision. Sample runs do not invalidate edits. */
export function editorVersion(version: FlowVersion) {
  const uiMeta = getFlowVersionUiMeta(version.id);
  const editorRevision = createHash('sha256').update(JSON.stringify({
    id: version.id, state: version.state, displayName: version.displayName,
    trigger: version.trigger, agentIds: version.agentIds, connectionIds: version.connectionIds, uiMeta,
  })).digest('hex');
  return { ...version, uiMeta, editorRevision };
}
