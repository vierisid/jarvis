import React, { useState } from 'react';
import type { ComponentType } from 'react';
import type { Configuration, Context, FeatureAdapter, Journey } from '../contract.ts';
import { fixture } from '../test-fixture.ts';
import { createDraftStore } from '../drafts.ts';
import { PebbleLayout } from '../../../brief/shell/pebble-layout/PebbleLayout.tsx';
import type { BriefShellPort } from '../../../brief/contracts.ts';
import { viewModules } from '../generated/catalog.ts';

const steps = ['today', 'workflows', 'opportunities', 'needs-you', 'goals', 'memory', 'connected-workspace', 'authority', 'profile', 'settings', 'billing', 'pebble'];
function Surface({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [draft, setDraft] = useState('');
  return <PebbleLayout enabled shell={{ mode: 'preview', chatOpen: open, setChatOpen: onOpenChange } as BriefShellPort}
    conversation={{ source: 'fixture', content: <section className="on-preview__room"><h2>Sample conversation</h2><p>Unsent text · no provider or socket</p><textarea aria-label="Unsent sample draft" data-pebble-focus value={draft} onChange={e => setDraft(e.target.value)} /></section> }}>
    <div className="on-preview__room"><h1>Today</h1><p>Illustrative room content. No live actions are available.</p></div>
  </PebbleLayout>;
}
function ResultSlot({ model, onContinue }: { model: Record<string, unknown>; onContinue: () => void }) {
  return <section className="on-preview__room"><h1>Saved draft fixture</h1><p>U09 is absent. This slot verifies the host handoff; it is not the workflow canvas.</p><p>Flow: {String(model.flowId)} · Version: {String(model.versionId)} · Disabled</p><button onClick={onContinue}>Continue to dashboard</button></section>;
}
function ResultCanvasSlot({ draft }: { draft: { flowId: string; versionId: string } }) {
  return <p>Canvas handoff fixture · {draft.flowId} / {draft.versionId}. The real D18 renderer is verified in U09’s isolated preview.</p>;
}
/** Explicit synthetic providers. No timers manufacture progress: the preview
 * operator advances build phases. Never imported by the production entry. */
export function previewConfiguration(options: { storage?: Pick<Storage, 'getItem' | 'setItem'>; mode?: 'full' | 'partial' | 'empty' | 'disabled'; start?: Journey['stepId'] } = {}) {
  const f = fixture();
  const config = f.config;
  const notify = new Set<() => void>();
  let open = false, cursor = 1, answered = false;
  const values = new Map<string, string>();
  const storage = options.storage ?? { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  const drafts = createDraftStore(storage, 'preview-only', 'journey');
  let activation = drafts.read('activation') ?? { prompt: '', contextRefs: [], answers: {} };
  let interview = drafts.read('interview') ?? { text: '', clientRequestId: 'preview-answer-1' };
  let requestId = 'fixture-request', phaseIndex = 0, eventRevision = 1, finished = false;
  const phases = ['understanding', 'building', 'validating', 'saving'];
  const bump = (patch: Partial<Journey>) => f.setJourney({ ...patch, revision: f.journey().revision + 1 });
  if (options.start && options.start !== 'welcome') bump({ stepId: options.start, setupState: 'completed', interviewState: 'done', tourState: 'done' });
  config.modules = config.modules.map(module => viewModules.find(real => real.manifest.id === module.manifest.id)
    ?? { ...module, load: async () => ({ ResultView: ResultSlot as unknown as ComponentType<Record<string, unknown>> }) });
  if (options.mode === 'empty') config.modules = [];
  if (options.mode === 'partial') config.modules = viewModules.filter(module => module.manifest.id !== 'ON-U-09');
  if (options.mode === 'disabled') config.enabled = false;
  const presentation = (name: string, context: Context): Awaited<ReturnType<FeatureAdapter['read']>> => {
    const j = context.journey;
    if (name === 'google') return { model: { connection: { state: 'idle' } } };
    if (name === 'interview') return { model: { sessionId: 'fixture-interview', turnId: 'fixture-turn', cursor, phase: j.interviewState === 'skipped' ? 'skipped' : answered ? 'done' : 'ready',
      messages: [{ id: 'question', role: 'assistant', text: 'What work would you like to make room for?' }], draft: interview, confirmedFactIds: answered ? ['fixture-fact'] : [], navigation: { revision: j.revision, kind: 'ready' } } };
    if (name === 'tour') return { model: { sessionId: 'fixture-tour', revision: j.revision, stepId: j.tourStepId ?? 'today', phase: 'ready', sidebar: 'rail' }, ports: {
      renderer: { isolation: 'fixture-only', renderRoom: ({ step }: { step: { room: string } }) => ({ status: 'ready', content: <section className="on-preview__room"><h1>{step.room}</h1><p>Illustrative room slot · D-line room integration remains a release requirement.</p></section> }) },
    } };
    if (name === 'pebble-tour') return { model: { sessionId: 'fixture-tour', revision: j.revision, phase: 'ready', sidebar: 'rail' }, ports: {
      adapter: { isolation: 'tutorial-sandbox', status: 'ready', open, Surface, onOpenChange: (value: boolean) => { open = value; notify.forEach(fn => fn()); } },
    } };
    if (name === 'activation') return { model: { journeyId: j.journeyId, revision: j.revision, availability: 'ready', phase: 'ready', draft: activation } };
    if (name === 'build') return { model: { journeyId: j.journeyId, jobId: 'fixture-job', requestId, revision: j.revision, title: 'Meeting follow-up', prompt: activation.prompt,
      availability: 'ready', transport: 'connected', cancellation: 'not_requested',
      status: { jobId: 'fixture-job', revision: eventRevision, outcome: finished ? 'succeeded' : 'working', phase: phases[phaseIndex], completedPhases: phases.slice(0, finished ? 4 : phaseIndex) },
      result: finished ? { state: 'ready', reference: { jobId: 'fixture-job', requestId, compositionRecordId: 'fixture-composition', flowId: 'fixture-flow', versionId: 'fixture-version', readiness: 'needs_input', activation: 'disabled' } } : { state: 'pending' },
      actions: { cancel: true, resume: true, openResult: true } } };
    const reference = { jobId: 'fixture-job', requestId, compositionRecordId: 'fixture-composition', flowId: 'fixture-flow', versionId: 'fixture-version', readiness: 'needs_input', activation: 'disabled' };
    const expected = { compositionRecordId: reference.compositionRecordId, flowId: reference.flowId, versionId: reference.versionId };
    return { model: { scopeId: j.scopeId, journeyId: j.journeyId, jobId: reference.jobId, requestId, revision: j.revision, expected,
      flowId: reference.flowId, versionId: reference.versionId,
      result: { availability: 'ready', state: 'saved', schemaVersion: 1, scopeId: j.scopeId, journeyId: j.journeyId, ...reference,
        contentRevision: 'fixture-content', title: 'Saved draft fixture', graph: { name: 'trigger', type: 'EMPTY', displayName: 'Fixture trigger' }, selectedNodeId: null,
        versionState: 'DRAFT', reference, readiness: { ready: false, issues: [], runtimeChecks: [] }, missingBindings: [],
        recovery: { operation: 'result.read', input: { schemaVersion: 1, jobId: reference.jobId, expected } },
        workflow: { room: 'workflow', selection: { flowId: reference.flowId, versionId: reference.versionId } },
        journey: { sync: 'settled', completion: 'active' },
        continuation: { operation: 'journey.transition', input: { journeyId: j.journeyId, expectedRevision: j.revision,
          requestId: 'result-finish:fixture', command: { type: 'finish' } } },
      } }, ports: { Canvas: ResultCanvasSlot } };

  };
  for (const name of ['google', 'interview', 'tour', 'pebble-tour', 'activation', 'build', 'result'] as const) config.adapters[name] = {
    available: () => true,
    create: () => ({
      available: () => true, read: async c => presentation(name, c),
      setDraft: (c, value) => {
        if (name === 'activation') { activation = value as Record<string, unknown>; drafts.save('activation', activation); }
        if (name === 'interview') { interview = { text: value, clientRequestId: `preview-answer-${++cursor}` }; drafts.save('interview', interview); }
        return presentation(name, c);
      },
      subscribe: changed => { notify.add(changed); return () => { notify.delete(changed); }; },
      command: async (c, action, value) => {
        const input = value as { request?: { requestId: string }; action?: string; to?: string } | undefined;
        if (name === 'interview' && (action === 'answer' || action === 'skip')) { answered ||= action === 'answer'; cursor++; bump({ interviewState: action === 'skip' ? 'skipped' : 'done' }); }
        if (name === 'tour' || name === 'pebble-tour') {
          if (action === 'skip' || input?.to === 'first-workflow') bump({ tourState: action === 'skip' ? 'skipped' : 'done', stepId: 'activation', tourStepId: null });
          else bump({ tourState: 'in_progress', tourStepId: input?.to ?? (action === 'open-pebble' ? 'pebble' : steps[1]!) });
        }
        if (name === 'result' && action === 'finish') {
          const model = presentation(name, c).model;
          const result = model.result as { continuation: { input: Record<string, unknown> } };
          await config.transport.call('journey.transition', result.continuation.input, c.signal);
        }
        if (name === 'activation' && action === 'create') { requestId = input?.request?.requestId ?? requestId; bump({ stepId: 'build', activationState: 'building', jobId: 'fixture-job', buildRequestId: requestId }); }
        if (name === 'build' && action === 'open_result' && finished) bump({ stepId: 'result', activationState: 'draft_saved', draft: { flowId: 'fixture-flow', versionId: 'fixture-version' } });
      },
    }),
  };
  return { config, calls: f.calls, advance() { eventRevision++; if (phaseIndex < 3) phaseIndex++; else finished = true; notify.forEach(fn => fn()); },
    disconnect() { f.status.ready = false; notify.forEach(fn => fn()); }, reconnect() { f.status.ready = true; },
    setJourney: f.setJourney, journey: f.journey };
}
