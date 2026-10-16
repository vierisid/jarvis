import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { available, WorkflowEditor, WorkflowEditorEnvironment, versionBoundRequest, CANVAS_CATALOG, NavigationShell, UNKNOWN_NAVIGATION } from 'on-u-09-canvas-fixture';
import { ResultView } from '../index';
import type { ResultAction, ResultCanvasProps } from '../index';
import { example, EXAMPLES, modelFor } from './fixtures';
import './preview.css';

/** Real D18 editor, isolated fixture transport. No global-fetch fallback or live effects. */
function Canvas({ draft, onDirtyChange, onUnavailable }: ResultCanvasProps) {
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const samples = useRef(new Map<string, string>());
  const invalid = useRef(onUnavailable); invalid.current = onUnavailable;
  const environment = useMemo(() => {
    let version = { id: draft.versionId, flowId: draft.flowId, state: 'DRAFT', displayName: draft.title, trigger: draft.graph,
      valid: true, schemaVersion: '1', agentIds: [], connectionIds: [], notes: [], backupFiles: {}, sampleData: {}, sampleInput: null, created: 1791363600000, updated: 1791363600000 };
    let uiMeta: unknown = { schema: 1, positions: {}, orphans: [] };
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const request = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input), method = init?.method ?? 'GET';
      if (method === 'GET') {
        if (path === `/api/workflows/${draft.flowId}`) return response({ flow: { id: draft.flowId, status: 'DISABLED' }, latestDraft: version, published: null, uiMeta });
        if (path === '/api/workflows/pieces') return response(CANVAS_CATALOG);
        if (path === '/api/workflows/pieces/library') return response({ managed: true, entries: [] });
        if (path === '/api/workflows/connections') return response({ connections: [] });
        if (path === '/api/workflows') return response([{ id: draft.flowId, displayName: draft.title }]);
        if (path.includes('/runs?')) return response([]);
      }
      if (method === 'PATCH' && path === `/api/workflows/${draft.flowId}/versions/${draft.versionId}`) {
        const body = JSON.parse(String(init?.body)); version = { ...version, trigger: body.trigger, displayName: body.displayName }; uiMeta = body.uiMeta; return response(version);
      }
      return response({ error: 'This isolated preview cannot run, connect, install, or publish anything.' }, 403);
    }, { preconnect: fetch.preconnect });
    const bound = versionBoundRequest(request, draft.flowId, draft.versionId);
    return { request: async (input: RequestInfo | URL, init?: RequestInit) => { try { return await bound(input, init); } catch (e) { invalid.current(); throw e; } }, workspace: true, sampleDrafts: samples.current };
    // The fixture edit buffer belongs to the exact version, not theme, chat or host reads.
  }, [draft.scopeId, draft.flowId, draft.versionId]);
  return <div className="brief-workflow-canvas result-preview-canvas"><WorkflowEditorEnvironment.Provider value={{ ...environment, portalHost }}>
    <WorkflowEditor workspace flowId={draft.flowId} onClose={() => {}} onDirtyChange={onDirtyChange} renderHeader={(c: any) => <div className="result-preview-editor-tools">
      <button disabled={!c.editor.dirty || c.saving} onClick={() => void c.save()}>Save changes</button>
      <button disabled={!c.editor.dirty || c.saving} onClick={c.discard}>Discard changes</button><span>{c.message?.text ?? (c.editor.dirty ? 'Unsaved changes' : 'Saved draft')}</span>
    </div>} /><div ref={setPortalHost} /></WorkflowEditorEnvironment.Provider></div>;
}
function Preview() {
  const [index, setIndex] = useState(0), [revision, setRevision] = useState(1), [scenario, setScenario] = useState('saved');
  const [theme, setTheme] = useState<'light' | 'dark'>('light'), [sidebar, setSidebar] = useState<'rail' | 'expanded'>('expanded');
  const [chatOpen, setChatOpen] = useState(false), [chat, setChat] = useState(''), [fail, setFail] = useState(false), [destination, setDestination] = useState('reveal');
  const [intent, setIntent] = useState<ResultAction | null>(null);
  const draft = example(index);
  if (scenario === 'missing inputs') { draft.readiness.ready = false; draft.reference.readiness = 'needs_input'; draft.readiness.issues = [{ node: 'send', path: 'settings.input.recipient', code: 'INPUT_REQUIRED', message: 'Choose a recipient and connect Gmail before running.' }]; }
  if (scenario === 'long labels') { draft.title += ' — a very detailed request with a long workflow name for your workspace'; const n = draft.graph.nextAction as Record<string, unknown>; n.displayName = 'Read and reconcile the meeting notes from several teams before preparing a carefully reviewed follow-up'; }
  if (scenario === 'completion unavailable') draft.continuation = null;
  const model = { ...modelFor(draft, revision), theme, result: ['pending', 'no_draft'].includes(scenario) ? { availability: 'ready', state: scenario }
    : scenario === 'deleted' ? { availability: 'unavailable', reason: 'artifact_unavailable' } : scenario === 'stale version' ? { ...draft, versionId: 'replacement' } : draft };
  const shell = { mode: 'preview', route: { room: 'workflow', selection: draft.workflow.selection }, sidebar, setSidebar, chatOpen, setChatOpen, theme, setTheme,
    navigate: (route: any) => { if (route.room === 'workflows') setDestination('workflows'); } };
  const binding = { capabilities: null, view: { source: 'fixture', state: { status: 'ready', data: { ...UNKNOWN_NAVIGATION, workspaceName: 'Sample workspace', connection: 'connected',
    account: { name: 'Sam', plan: { status: 'ready', data: 'Preview' } }, objectTitle: draft.title, badges: {} } } } };
  async function action(a: ResultAction) {
    setIntent(a); if (fail) { setFail(false); throw new Error('Illustrative uncertain delivery'); }
    if (a.action === 'finish') setDestination('dashboard');
    if (a.action === 'open_workflow') setDestination('workflows');
    if (a.action === 'back') setDestination('request');
    if (a.action === 'refresh') setRevision(x => x + 1);
  }
  return <div className="brief-root result-preview" data-brief-theme={theme}>
    <div className="result-preview-controls"><strong>ON-U-09 · Isolated preview</strong>
      <label>Example <select value={index} onChange={e => { setIndex(Number(e.target.value)); setRevision(x=>x+1); setDestination('reveal'); }}>{EXAMPLES.map((s, i)=><option key={s} value={i}>{s}</option>)}</select></label>
      <label>Scenario <select value={scenario} onChange={e => { setScenario(e.target.value); setRevision(x=>x+1); setDestination('reveal'); }}>{['saved', 'missing inputs', 'long labels', 'pending', 'no_draft', 'deleted', 'stale version', 'completion unavailable', 'missing canvas'].map(s=><option key={s}>{s}</option>)}</select></label>
      <button onClick={()=>setTheme(theme==='light'?'dark':'light')}>Switch theme</button>
      <button onClick={()=>setSidebar(sidebar==='rail'?'expanded':'rail')}>Toggle sidebar</button>
      <button onClick={()=>setChatOpen(x=>!x)}>Toggle chat</button>
      <label><input type="checkbox" checked={fail} onChange={e=>setFail(e.target.checked)} />Fail next action</label>
      <small>Illustrative data · local edits only · {available ? 'real D18 canvas' : 'D18 unavailable'}</small>
    </div>
    <div className="result-preview-viewport"><NavigationShell shell={shell} binding={binding} rooms={{ workflow: { id: 'workflow', title: 'Workflows' } }}
      conversation={{ source: 'fixture', content: <div className="result-preview-chat"><h2>General</h2><p>Unsent sample conversation</p><textarea data-pebble-focus aria-label="Unsent chat draft" value={chat} onChange={e=>setChat(e.target.value)} /></div> }}>
      {destination === 'reveal' ? <ResultView model={model} Canvas={available && scenario !== 'missing canvas' ? Canvas : undefined} onContinue={action} onRefresh={action} onOpenWorkflow={action} onBack={action} />
        : <section className="result-preview-destination"><h1>{destination === 'workflows' ? 'Workflows · saved draft' : destination === 'dashboard' ? 'Dashboard continuation' : 'Your original request'}</h1>
          <p>Illustrative host navigation. Same draft: {draft.flowId} / {draft.versionId}.</p><button onClick={()=>{ setDestination('reveal'); setRevision(x=>x+1); }}>Open saved draft</button></section>}
    </NavigationShell></div><output className="result-preview-output">{intent ? `${intent.action} · ${intent.jobId} · ${intent.draft?.flowId ?? 'recover'} / ${intent.draft?.versionId ?? 'unknown'}` : 'No action submitted'}</output>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
