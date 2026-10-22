import React, { useEffect, useState } from 'react';
import type { BriefRoomRegistry, BriefShellPort } from '../contracts';
import { BRIEF_ROOMS } from '../rooms/registry';
import { BriefButton } from '../components/controls';
import { WorkflowCreationController } from '../workflows/create/controller';
import { createCompositionPort } from '../workflows/create/client';
import { WorkflowCreationRoom } from '../workflows/create/WorkflowCreationRoom';
import { readRecentWorkflows } from '../workflows/recent-rows/read';
import type { RecentWorkflowBinding } from '../workflows/recent-rows/model';
import { readIngredientCatalog } from '../workflows/ingredient-picker/read';
import type { IngredientCatalog } from '../workflows/ingredient-picker/model';
import { WorkflowCanvasRoom } from '../workflows/canvas/WorkflowCanvasRoom';
import { WorkflowManagementController } from '../workflows/manage-list/controller';
import { WorkflowManagementRoom } from '../workflows/manage-list/WorkflowManagementRoom';
import { WorkflowRunsController } from '../workflows/runs/controller';
import { WorkflowRunsRoom } from '../workflows/runs/WorkflowRunsRoom';
import { briefRunsPort } from '../workflows/runs/read';
import type { ManualRunRequest, ManualRunResult } from '../workflows/runs/model';
import { WorkflowContextController } from '../workflows/context/controller';
import { WorkflowContextRoom } from '../workflows/context/WorkflowContextRoom';
import { WorkflowViewHeader } from '../workflows/runs/WorkflowViewHeader';
import type { InspectionSelection } from '../../../../src/brief/workflow-context-contracts';
import { isBriefCapabilityEnabled } from '../../../../src/brief/capabilities';
import type { HostTransport } from './http';
import { post } from './http';

export interface WorkflowHost {
  scopeId: string; transport: HostTransport; capabilities(): unknown;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  dirty(key: string, value: boolean): void;
  /** Collect explicit manual input; null means the user cancelled before dispatch. */
  runInput(): Promise<Record<string, unknown> | null>;
}
/** Controllers belong to the authenticated host, never to room renders. */
export function createWorkflowRooms(host: WorkflowHost) {
  const { scopeId, transport } = host;
  const key = `brief:workflow-creation:v1:${scopeId}`;
  const creation = new WorkflowCreationController(createCompositionPort(host.capabilities, transport.request),
    { read: () => host.storage.getItem(key), write: value => host.storage.setItem(key, value) }, { source: 'live', scopeId });
  const management = new WorkflowManagementController(scopeId, 'live', {
    read: async signal => {
      const v = await transport.json('/api/brief/workflows', { signal });
      if (!['ready', 'empty'].includes(v.state) || v.data?.scopeId !== scopeId) throw new Error('Workflow list unavailable');
      return { status: 'ready', data: v.data };
    },
    change: command => transport.json('/api/brief/workflows/commands', post(command)),
    reconcile: command => transport.json(`/api/brief/workflows/requests/${encodeURIComponent(command.requestId)}`),
  });
  const selections = new Map<string, { runs: WorkflowRunsController; context: WorkflowContextController }>();
  function controllers(flowId: string, versionId: string, editable: boolean) {
    const key = JSON.stringify([flowId, versionId, editable]); let value = selections.get(key);
    if (value) return value;
    const base = `/api/brief/workflows/${encodeURIComponent(flowId)}`;
    const scope = { scopeId, flowId, versionId };
    const journal = `brief:manual-run:pending:v1:${scopeId}:${flowId}:${versionId}`;
    let pending: ManualRunRequest | undefined;
    try { const stored = JSON.parse(host.storage.getItem(journal) ?? 'null');
      if (stored?.scopeId === scopeId && stored.flowId === flowId && stored.versionId === versionId && typeof stored.requestId === 'string') pending = stored;
    } catch { /* Invalid local state cannot supply an execution identity. */ }
    // Clear only this request's own entry; another window may have journaled a newer one.
    const clear = (requestId: string) => { try {
      if (JSON.parse(host.storage.getItem(journal) ?? 'null')?.requestId === requestId) host.storage.setItem(journal, 'null');
    } catch { /* The lock stays until a check answers. */ } };
    // F-21's keyset reader owns run history (#1100); this host adds only the explicit
    // Run start and a reload-safe journal of an unconfirmed request.
    const read = briefRunsPort(scope, transport.request);
    const runs = new WorkflowRunsController(scope, {
      list: read.list, detail: read.detail,
      ...(!editable ? { start: async (request: ManualRunRequest): Promise<ManualRunResult> => {
        const payload = await host.runInput();
        if (payload === null || transport.signal.aborted || !isBriefCapabilityEnabled(host.capabilities(), 'workflowContext')) return { status: 'not_submitted', requestId: request.requestId };
        // Persist the identity before dispatch, or do not dispatch at all.
        try { host.storage.setItem(journal, JSON.stringify(request)); }
        catch { return { status: 'rejected', requestId: request.requestId, message: 'No run started: this device could not record the request. Try again.' }; }
        const response = await transport.request(`/api/workflows/${encodeURIComponent(flowId)}/run`, post({ brief: { scopeId, versionId, requestId: request.requestId }, payload }));
        if (response.ok) return await response.json();
        const code = await response.clone().json().then((body: { code?: unknown } | null) => body?.code, () => undefined);
        // request_conflict means a run was already accepted under this ID: never "no run".
        if ([400, 403, 404, 409, 422].includes(response.status) && code !== 'request_conflict')
          return { status: 'rejected', requestId: request.requestId, message: 'No run started. Review workflow readiness and Authority, then try again.' };
        // Anything else is uncertain: the controller locks Run until an explicit check.
        return { status: 'uncertain', requestId: request.requestId };
      }, reconcile: read.reconcile } : {}),
    }, editable ? undefined : pending);
    // The journal is cleared only when this controller settles its own request: a
    // validated acceptance, a definite refusal, or a check that found no record.
    // Ordinary emits never clear it, so another window's pending journal survives.
    let held = runs.getSnapshot();
    runs.subscribe(() => {
      const state = runs.getSnapshot(), was = held; held = state;
      if (was.request && ['pending', 'uncertain', 'checking'].includes(was.submission)
        && (state.submission === 'accepted' || (state.submission === 'idle' && state.request === null))) clear(was.request.requestId);
    });
    const context = new WorkflowContextController(scope, { read: async (_scope, query, signal) => {
      const params = new URLSearchParams({ versionId });
      if (query.basis === 'recorded') params.set('runId', query.runId);
      const v = await transport.json(base + '/inspection?' + params, { signal });
      if (v.status !== 'ready' || v.data?.scopeId !== scopeId) throw new Error('Context unavailable');
      return { status: 'ready', data: v.data.context };
    } });
    value = { runs, context }; selections.set(key, value); return value;
  }
  function Creation({ shell }: { shell: BriefShellPort }) {
    const [recent, setRecent] = useState<RecentWorkflowBinding>({ source: 'live', state: { status: 'loading' } });
    const [ingredients, setIngredients] = useState<IngredientCatalog>({ source: 'live', scopeId, state: 'loading', choices: [] });
    useEffect(() => {
      const abort = new AbortController();
      void readRecentWorkflows(transport.request, abort.signal).then(state => { if (!abort.signal.aborted) setRecent({ source: 'live', state }); });
      void readIngredientCatalog(host.capabilities, abort.signal, transport.request).then(choices => {
        if (!abort.signal.aborted) setIngredients({ source: 'live', scopeId, state: 'ready', choices });
      }, () => { if (!abort.signal.aborted) setIngredients({ source: 'live', scopeId, state: 'unavailable', choices: [] }); });
      return () => abort.abort();
    }, []);
    return <WorkflowCreationRoom shell={shell} binding={{ controller: creation, capabilities: host.capabilities(), recent, ingredients }} />;
  }
  function Management({ shell }: { shell: BriefShellPort }) {
    return <WorkflowManagementRoom shell={shell} binding={{ source: 'live', scopeId, capabilities: host.capabilities(), controller: management }} />;
  }
  function Selected({ shell }: { shell: BriefShellPort }) {
    const { flowId, versionId, runId } = shell.route.selection;
    const [selection, setSelection] = useState<{ flowId: string; versionId: string; title: string; editable: boolean; inspection: InspectionSelection } | null>(null);
    const [error, setError] = useState(false), [revision, retry] = useState(0);
    useEffect(() => {
      const abort = new AbortController(); setSelection(null); setError(false);
      void (async () => {
        if (!flowId) throw new Error('Select a workflow');
        const detail = await transport.json(`/api/workflows/${encodeURIComponent(flowId)}`, { signal: abort.signal });
        if (detail.flow?.id !== flowId) throw new Error('Workflow changed');
        const version = versionId ? await transport.json(`/api/workflows/${encodeURIComponent(flowId)}/versions/${encodeURIComponent(versionId)}`, { signal: abort.signal })
          : detail.latestDraft ?? detail.published;
        if (!version || version.flowId !== flowId || !['DRAFT', 'LOCKED'].includes(version.state)) throw new Error('Version unavailable');
        if (shell.route.room === 'workflow-draft' && version.state !== 'DRAFT') throw new Error('Draft changed');
        const params = new URLSearchParams({ versionId: version.id }); if (runId) params.set('runId', runId);
        const value = await transport.json(`/api/brief/workflows/${encodeURIComponent(flowId)}/inspection?${params}`, { signal: abort.signal });
        if (value.status !== 'ready' || value.data?.scopeId !== scopeId || value.data.flowId !== flowId || value.data.versionId !== version.id) throw new Error('Inspection unavailable');
        if (!abort.signal.aborted) setSelection({ flowId, versionId: version.id, title: version.displayName, editable: version.state === 'DRAFT', inspection: value.data });
      })().catch(() => { if (!abort.signal.aborted) setError(true); });
      return () => abort.abort();
    }, [flowId, versionId, runId, shell.route.room, revision]);
    if (!selection) return <section><h1 className="brief-type-room-title">Workflow</h1><p role="status">{error ? 'This workflow version is unavailable. Your selected IDs are retained.' : 'Loading workflow…'}</p>
      {error && <BriefButton onClick={() => retry(v => v + 1)}>Check again</BriefButton>}<BriefButton onClick={() => shell.navigate({ room: 'all-workflows', selection: {} })}>All workflows</BriefButton></section>;
    const { runs, context } = controllers(selection.flowId, selection.versionId, selection.editable);
    const binding = { source: 'live' as const, scopeId, flowId: selection.flowId, versionId: selection.versionId, title: selection.title, capabilities: host.capabilities() };
    if (shell.route.room === 'workflow-runs') return <WorkflowRunsRoom shell={shell} binding={{ ...binding, controller: runs }} />;
    if (shell.route.room === 'workflow-context') return <WorkflowContextRoom shell={shell} binding={{ ...binding, controller: context, runs,
      openSource: source => {
        const room = source.kind === 'goal' ? 'goals' : source.kind === 'fact' ? 'memory-detail' : source.kind === 'workflow' ? 'workflow' : source.kind === 'rule' ? 'authority' : 'connected-workspace';
        shell.navigate({ room, selection: source.kind === 'goal' ? { goalId: source.id } : source.kind === 'fact' ? { factId: source.id } : source.kind === 'workflow' ? { flowId: source.id } : {} });
      } }} />;
    return <WorkflowCanvasRoom shell={shell} binding={{ ...binding, request: transport.request,
      readOnly: !selection.editable,
      ...(!selection.editable ? { run: async () => {
        await runs.start(); const state = runs.getSnapshot();
        if (state.submission === 'accepted' && state.selectedId) shell.navigate({ room: 'workflow-runs', selection: { flowId: selection.flowId, versionId: selection.versionId, runId: state.selectedId } });
        return { ok: state.submission === 'accepted', message: state.message };
      }, edit: async () => {
        const base = `/api/workflows/${encodeURIComponent(selection.flowId)}`;
        const detail = await transport.json(base);
        const version = detail.latestDraft ?? await (async () => {
          const current = await transport.json(`${base}/versions/${encodeURIComponent(selection.versionId)}`);
          return transport.json(base + '/versions', post({ displayName: current.displayName, trigger: current.trigger, ...(current.uiMeta ? { uiMeta: current.uiMeta } : {}) }));
        })();
        if (!version?.id || version.flowId !== selection.flowId || version.state !== 'DRAFT') throw Error('Draft unavailable');
        shell.navigate({ room: 'workflow-draft', selection: { flowId: selection.flowId, versionId: version.id } });
      } } : { publish: async () => {
        const { version } = await transport.json(`/api/workflows/${encodeURIComponent(selection.flowId)}/publish`, post({ versionId: selection.versionId }));
        if (!version || version.id !== selection.versionId || version.state !== 'LOCKED') throw Error('Publication unconfirmed');
        shell.navigate({ room: 'workflow', selection: { flowId: selection.flowId, versionId: selection.versionId } });
      } }),
      onDirtyChange: dirty => host.dirty(`workflow:${selection.flowId}:${selection.versionId}`, dirty) }} />;
  }
  const rooms: BriefRoomRegistry = {
    workflows: { ...BRIEF_ROOMS.workflows, Body: Creation }, 'all-workflows': { ...BRIEF_ROOMS['all-workflows'], Body: Management },
    ...Object.fromEntries(['workflow', 'workflow-preview', 'workflow-draft', 'workflow-runs', 'workflow-context'].map(id => [id, { ...BRIEF_ROOMS[id as keyof typeof BRIEF_ROOMS], Body: Selected }])),
  };
  return { rooms, creation, management, controllers, refresh() { void management.refresh(); for (const value of selections.values()) void value.runs.refresh(); },
    retire() { creation.dispose(); management.retire(); for (const value of selections.values()) { value.runs.retire(); value.context.retire(); } selections.clear(); } };
}
