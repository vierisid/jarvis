import { createHash } from 'node:crypto';
import type { FlowVersion } from '../db/repos/flow-version';
import { getFlowVersionUiMeta } from '../db/repos/flow-version-ui-meta';
import { stepsAsShown } from '../runtime/step-credentials';

/**
 * A version as the dashboard is shown it: its sample data (copied from run
 * outputs) without generated passwords or webhook credential headers, as run
 * history shows them. Read side only; the stored map still feeds test runs.
 */
export function versionAsShown<V extends { trigger: FlowVersion['trigger']; sampleData: Record<string, unknown> | null }>(version: V): V {
  return version.sampleData ? { ...version, sampleData: stepsAsShown(version.sampleData, version.trigger).steps } : version;
}

/** Authoring content and layout share a revision. Sample runs do not invalidate edits. */
export function editorVersion(version: FlowVersion) {
  const uiMeta = getFlowVersionUiMeta(version.id);
  const editorRevision = createHash('sha256').update(JSON.stringify({
    id: version.id, state: version.state, displayName: version.displayName,
    trigger: version.trigger, agentIds: version.agentIds, connectionIds: version.connectionIds, uiMeta,
  })).digest('hex');
  return { ...versionAsShown(version), uiMeta, editorRevision };
}
