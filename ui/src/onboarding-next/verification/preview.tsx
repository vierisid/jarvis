import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { views, host, inventory, candidate } from './catalog';
import { fixtureProps } from './fixtures';
import { JOURNEYS, requiredCases } from './matrix';
import type { Case } from './matrix';
import '../../brief/styles/index.css';
import '../../v2/v2.css';
import '../../v2/ui/primitives.css';
import './preview.css';
const params = new URLSearchParams(location.search), cases = requiredCases();
const current = cases.find(c => c.id === params.get('case'));
const theme = current?.theme ?? (params.get('theme') === 'dark' ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
function Scene({ test }: { test: Case }) {
  const [patch, update] = useState<any>({});
  const props = fixtureProps(test, (change: any) => update((old: any) => ({ ...old, ...change })));
  props.model = { ...props.model, ...patch };
  if (props.adapter && 'open' in patch) props.adapter = { ...props.adapter, open: patch.open };
  const View = views[test.view];
  return <main data-u11-scene data-case={test.id} data-view={test.view} data-state={test.state} data-sidebar={test.sidebar}>
    {View ? <View {...props} /> : <section role="status"><h1>Required view unavailable</h1><p>{test.owner} is absent; this case is blocked.</p></section>}
  </main>;
}
function Journey({ name }: { name: string }) {
  const [epoch, reset] = useState(0), [trace, setTrace] = useState<string[]>([]);
  const assembly = useMemo(() => {
    if (!host) return null;
    const full = host.previewConfiguration({ mode: 'full' });
    full.config.modules = full.config.modules.filter((m: any) => inventory.views.includes(m.manifest.id === 'ON-U-09' ? 'result' : ({'ON-U-01':'welcome','ON-U-02':'explainer','ON-U-03':'google','ON-U-04':'interview','ON-U-05':'tour','ON-U-06':'pebble-tour','ON-U-07':'activation','ON-U-08':'build'} as any)[m.manifest.id]));
    let failed = name === 'failed-build-retry', retry = 0;
    const observers = new Set<() => void>();
    full.notifyFixture = () => observers.forEach(fn => fn());
    for (const [key, binding] of Object.entries<any>(full.config.adapters)) {
      const create = binding.create;
      binding.create = () => {
        const adapter = create(), read = adapter.read, command = adapter.command;
        const subscribe = adapter.subscribe;
        adapter.subscribe = (notify: () => void) => { observers.add(notify); const dispose = subscribe?.(notify); return () => { observers.delete(notify); dispose?.(); }; };
        adapter.read = async (context: any) => {
          const result = await read(context);
          if (key === 'google' && name !== 'skip-connection-interview') result.model.connection = { state: 'connected', attemptId: 'fixture-attempt', accountLabel: 'demo@example.test', grantedAccessSummary: 'Fixture verification only.' };
          if (key === 'build' && failed) result.model = { ...result.model, status: { jobId: result.model.jobId, revision: 100, outcome: 'failed', safeError: 'Fixture build failed before saving.' }, result: { state: 'pending' }, actions: { retry: true, explore: true } };
          if (key === 'build' && retry) result.model = { ...result.model, jobId: 'fixture-retry', requestId: 'fixture-request-retry', status: { ...result.model.status, jobId: 'fixture-retry' }, result: result.model.result.state === 'ready' ? { ...result.model.result, reference: { ...result.model.result.reference, jobId: 'fixture-retry', requestId: 'fixture-request-retry' } } : result.model.result };
          return result;
        };
        adapter.command = async (context: any, action: string, payload: any) => {
          setTrace(old => [...old, `${key}:${action}`]);
          if (key === 'build' && action === 'retry') { failed = false; retry++; full.setJourney({ ...full.journey(), revision: full.journey().revision + 1 }); return; }
          return command(context, action, payload);
        };
        return adapter;
      };
    }
    return full;
  }, [epoch, name]);
  const Entry = host?.Entry;
  return <><nav className="u11-tools" aria-label="Fixture controls"><button onClick={() => { reset(n => n + 1); setTrace([]); }}>Restart journey</button><button onClick={() => assembly?.advance()}>Advance observed build phase</button><button onClick={() => assembly?.disconnect()}>Disconnect fixture</button><button onClick={() => assembly?.reconnect()}>Restore fixture connection</button>
    <button onClick={() => { if (assembly) { assembly.setJourney({ ...assembly.journey(), revision: assembly.journey().revision + 1, stepId: 'tour', tourState: 'in_progress', tourStepId: 'today' }); assembly.notifyFixture(); setTrace(old => [...old, 'fixture:replay']); } }}>Replay tour fixture</button></nav>
    <main data-u11-scene data-view="journey" data-state={name}>{Entry && assembly ? <Entry key={epoch} configuration={assembly.config} legacy={<section><h1>Legacy fallback selected</h1><p>Required real views are missing. Journey blocked.</p></section>}><h1>Dashboard handoff</h1></Entry> : <h1>ON-U-10 assembly unavailable</h1>}</main>
    <output className="u11-trace" aria-label="Fixture command trace">{trace.join('\n')}</output></>;
}
function App() {
  const journey = current?.kind === 'journey' ? current.state : params.get('journey');
  return <div className="brief-root jarvis-v2-root u11-root" data-u11-revision={candidate.revision} data-u11-dirty={String(candidate.dirty)} data-theme={theme} data-brief-theme={theme}>
    <header className="u11-banner"><strong>ON-U-11 · visual fixture</strong><span>Actual views · synthetic providers · no real effects</span></header>
    {journey && (JOURNEYS as readonly string[]).includes(journey) ? <Journey name={journey} /> : current ? <Scene test={current} /> : <main className="u11-index"><h1>Onboarding acceptance fixtures</h1><p>Missing dependencies stay blocked. Use browser native zoom and reduced-motion preferences; CSS scale is not zoom evidence.</p><h2>Replay a journey</h2>{JOURNEYS.map(name => <p key={name}><a href={`?journey=${name}`}>{name}</a></p>)}<h2>Required view states</h2>{cases.filter(c => c.kind === 'layout' && c.theme === 'light' && c.width === 1440 && c.sidebar === 'expanded').map(c => <p key={c.id}><a href={`?case=${c.id}`}>{c.owner} · {c.view} · {c.state}</a></p>)}</main>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
