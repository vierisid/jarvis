import React, { useState } from 'react';
import { PebbleLayout } from './catalog';
import type { Case } from './matrix';
const noop = () => {};
export const LONG = 'Review the meeting notes, confirm the recipient and retain this unfinished draft before continuing. '.repeat(12);
export function Surface({ open, onOpenChange }: { open: boolean; onOpenChange(value: boolean): void }) {
  const [draft, setDraft] = useState('Unsent fixture draft');
  if (!PebbleLayout) return <p>D06 surface unavailable.</p>;
  return <PebbleLayout enabled shell={{ mode: 'preview', chatOpen: open, setChatOpen: onOpenChange }}
    conversation={{ source: 'fixture', content: <section className="u11-room"><h2>Sample conversation</h2><p>No provider or socket. Nothing is sent.</p><textarea aria-label="Unsent sample draft" data-pebble-focus value={draft} onChange={e => setDraft(e.target.value)} /></section> }}>
    <section className="u11-room"><h1>Sample room</h1><p>Illustrative background; D-line room binding remains blocked.</p><button>Selected item</button></section>
  </PebbleLayout>;
}
export function resultModel(theme: string) {
  const reference = { jobId: 'fixture-job', requestId: 'fixture-request', compositionRecordId: 'fixture-composition', flowId: 'fixture-flow', versionId: 'fixture-version', readiness: 'ready', activation: 'disabled' };
  const expected = { compositionRecordId: reference.compositionRecordId, flowId: reference.flowId, versionId: reference.versionId };
  return { scopeId: 'fixture-scope', journeyId: 'fixture-journey', jobId: reference.jobId, requestId: reference.requestId, revision: 1, theme, expected,
    result: { availability: 'ready', state: 'saved', schemaVersion: 1, scopeId: 'fixture-scope', journeyId: 'fixture-journey', ...reference,
      contentRevision: 'fixture-content', title: 'Meeting follow-up draft', graph: { name: 'trigger', type: 'EMPTY', displayName: 'Fixture trigger' }, selectedNodeId: null,
      versionState: 'DRAFT', reference, readiness: { ready: true, issues: [], runtimeChecks: [] }, missingBindings: [],
      recovery: { operation: 'result.read', input: { schemaVersion: 1, jobId: reference.jobId, expected } },
      workflow: { room: 'workflow', selection: { flowId: reference.flowId, versionId: reference.versionId } }, journey: { sync: 'settled', completion: 'active' },
      continuation: { operation: 'journey.transition', input: { journeyId: 'fixture-journey', expectedRevision: 1, requestId: 'fixture-finish', command: { type: 'finish' } } } } };
}
/** Local serializable fixtures for actual controlled views. No service or network effects. */
export function fixtureProps(test: Case, update: (patch: any) => void): any {
  const { state, theme, sidebar, view } = test;
  const common = { theme, revision: 1 }, message = state === 'long' ? LONG : 'Connection interrupted. Your saved progress is retained.';
  if (view === 'welcome') return { model: { ...common, installMode: ['self','unknown'].includes(state) ? state : 'hosted', state: { kind: ['pending','error'].includes(state) ? state : 'ready', message } }, onSetUp: noop, onExit: noop, onThemeChange: noop,
    ...(state === 'long' ? { copy: { title: 'Your AI Co-Founder', subtitle: 'Let’s make room to build.', description: LONG } } : {}) };
  if (view === 'explainer') return { model: { ...common, state: { kind: ['pending','error'].includes(state) ? state : 'ready', message } }, onBack: noop, onContinue: noop,
    ...(state === 'long' ? { copy: { title: 'Less repetition. More room to build.', description: LONG, steps: [1,2,3].map(n => ({ title: `Step ${n}`, description: LONG })), alternativeTitle: 'Describe your routine', alternativeDescription: LONG } } : {}) };
  if (view === 'google') return { model: { ...common, connection: { state: state === 'long' ? 'connected' : state === 'navigation-pending' ? 'idle' : state, attemptId: 'fixture-attempt', accountLabel: state === 'long' ? 'account'.repeat(30)+'@example.test' : 'demo@example.test', grantedAccessSummary: state === 'long' ? LONG : 'Read Gmail and Calendar; no send permission.', message }, navigation: { kind: state === 'navigation-pending' ? 'pending' : 'ready', message } }, onConnect: noop, onCancel: noop, onBack: noop, onSkip: noop, onContinue: noop };
  if (view === 'interview') return { model: { ...common, sessionId: 'fixture-session', turnId: 'fixture-turn', cursor: 1, phase: ['resumed','long','navigation-pending'].includes(state) ? 'ready' : state === 'streaming' ? 'thinking' : state === 'saving-error' ? 'error' : state === 'unknown-facts' ? 'done' : state,
    resumed: state === 'resumed', messages: [{ id: 'question', role: 'assistant', text: state === 'long' ? LONG : 'What repeated work takes time from your goals?', streaming: state === 'streaming' }], draft: { text: state === 'long' ? LONG : '', clientRequestId: 'fixture-answer' }, confirmedFactIds: state === 'unknown-facts' ? null : ['fixture-fact'], error: message, recovery: { kind: 'session' }, navigation: { revision: 1, kind: state === 'navigation-pending' ? 'pending' : 'ready' } }, onDraftChange: (text: string) => update({ draft: { text, clientRequestId: 'fixture-answer' } }), onSubmit: noop, onRetry: noop, onSkip: noop, onContinue: noop };
  if (view === 'tour') return { model: { ...common, sessionId: 'fixture-tour', stepId: ['moving','error','unavailable'].includes(state) ? 'today' : state, phase: ['moving','error'].includes(state) ? state : 'ready', sidebar, error: message }, onNavigate: noop,
    renderer: state === 'unavailable' ? undefined : { isolation: 'fixture-only', renderRoom: ({ step }: any) => ({ status: 'ready', content: <section className="u11-room"><h1>{step.room}</h1><p>Illustrative room slot. The tutorial card is real; full D-line room integration is not verified here.</p></section> }) } };
  if (view === 'pebble-tour') return { model: { ...common, sessionId: 'fixture-tour', phase: ['moving','error'].includes(state) ? state : 'ready', sidebar }, onNavigate: noop,
    adapter: { isolation: 'tutorial-sandbox', status: state === 'unavailable' ? 'unsupported' : state === 'error' ? 'error' : 'ready', open: state === 'open', Surface, onOpenChange: (open: boolean) => update({ open }) } };
  if (view === 'activation') return { model: { ...common, journeyId: 'fixture-journey', availability: ['unavailable','unsupported'].includes(state) ? state : 'ready', phase: state === 'missing-connection' ? 'needs_input' : ['long','unavailable','unsupported'].includes(state) ? 'ready' : state,
    draft: { prompt: state === 'long' ? LONG : 'Prepare meeting follow-ups for my review.', contextRefs: [], answers: {} },
    issues: state === 'missing-connection' ? [{ id: 'google', kind: 'connection', label: 'Choose a Google account', message: 'This workflow needs a verified Google connection before it can continue.' }]
      : ['needs_input','invalid'].includes(state) ? [{ id: 'recipient', kind: 'detail', label: 'Recipient', message: 'Choose who should receive the draft.' }] : [], message },
    canResolveConnection: state === 'missing-connection', onDraftChange: (draft: any) => update({ draft }), onIntent: noop };
  if (view === 'build') {
    const phases = ['understanding','building','validating','saving'], phase = phases.includes(state) ? state : 'understanding';
    const outcome = ['queued','needs_input','failed','cancelled'].includes(state) ? state : state === 'saved' ? 'succeeded' : 'working';
    return { model: { ...common, journeyId: 'fixture-journey', jobId: 'fixture-job', requestId: 'fixture-request', title: state === 'long' ? LONG : 'Meeting follow-up', prompt: message,
      availability: state === 'unavailable' ? 'unavailable' : 'ready', transport: state === 'disconnected' ? 'disconnected' : 'connected', timedOut: state === 'timed-out', cancellation: state === 'cancelling' ? 'requested' : 'not_requested',
      status: { jobId: 'fixture-job', revision: 1, outcome, phase, completedPhases: phases.slice(0, phases.indexOf(phase)), safeError: message, missingInputs: ['Choose a recipient.'] },
      result: { state: state === 'saved' ? 'ready' : 'pending', reference: (resultModel(theme).result as any).reference }, actions: { cancel: true, resume: true, retry: true, provide_input: true, explore: true, openResult: true } }, onIntent: noop };
  }
  const model: any = resultModel(theme);
  if (state === 'pending') model.result = { availability: 'ready', state: 'pending' };
  if (state === 'deleted') model.result = { availability: 'unavailable', reason: 'artifact_unavailable' };
  return { model, onContinue: noop, onBack: noop, onRefresh: noop, onOpenWorkflow: noop };
}
