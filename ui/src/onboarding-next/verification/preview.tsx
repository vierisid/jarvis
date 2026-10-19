import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OptionalOnboardingEntry } from '../host/Entry.tsx';
import { views } from './views';
import { fixtureProps } from './fixtures';
import { journeyAssembly } from './journey';
import { JOURNEYS, fixtureCases } from './matrix';
import type { Case } from './matrix';
import '../../brief/styles/index.css';
import '../../v2/v2.css';
import '../../v2/ui/primitives.css';
import './preview.css';
const params = new URLSearchParams(location.search), cases = fixtureCases();
const current = cases.find(c => c.id === params.get('case'));
const theme = current?.theme ?? (params.get('theme') === 'dark' ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
function Scene({ test }: { test: Case }) {
  const [patch, update] = useState<any>({});
  const props = fixtureProps(test, (change: any) => update((old: any) => ({ ...old, ...change })));
  props.model = { ...props.model, ...patch };
  if (props.adapter && 'open' in patch) props.adapter = { ...props.adapter, open: patch.open };
  const View = views[test.view];
  return <main data-u11-scene data-case={test.id} data-view={test.view} data-state={test.state} data-sidebar={test.sidebar}><View {...props} /></main>;
}
function Journey({ name }: { name: string }) {
  const [epoch, reset] = useState(0), [trace, setTrace] = useState<string[]>([]);
  const assembly = useMemo(() => journeyAssembly(name, entry => setTrace(old => [...old, entry])), [epoch, name]);
  return <><nav className="u11-tools" aria-label="Fixture controls"><button onClick={() => { reset(n => n + 1); setTrace([]); }}>Restart journey</button><button onClick={() => assembly.advance()}>Advance observed build phase</button><button onClick={() => assembly.disconnect()}>Disconnect fixture</button><button onClick={() => assembly.reconnect()}>Restore fixture connection</button>
    <button onClick={() => assembly.replayTour()}>Replay tour fixture</button></nav>
    <main data-u11-scene data-view="journey" data-state={name}><OptionalOnboardingEntry key={epoch} configuration={assembly.config} legacy={<section><h1>Legacy fallback selected</h1><p>The onboarding assembly refused this configuration.</p></section>}><h1>Dashboard handoff</h1></OptionalOnboardingEntry></main>
    <output className="u11-trace" aria-label="Fixture command trace">{trace.join('\n')}</output></>;
}
function App() {
  const journey = params.get('journey');
  const link = (c: Case) => <a key={c.id} href={`?case=${c.id}`}>{c.theme}{c.sidebar === 'rail' ? ' rail' : ''}</a>;
  return <div className="brief-root jarvis-v2-root u11-root" data-theme={theme} data-brief-theme={theme}>
    <header className="u11-banner"><strong>ON-U-11 - onboarding fixtures</strong><span>Actual views - synthetic providers - no real effects</span></header>
    {journey && (JOURNEYS as readonly string[]).includes(journey) ? <Journey name={journey} /> : current ? <Scene test={current} /> : <main className="u11-index"><h1>Onboarding fixtures</h1>
      <h2>Replay a journey</h2>{JOURNEYS.map(name => <p key={name}>{name}: <a href={`?journey=${name}`}>light</a> <a href={`?journey=${name}&theme=dark`}>dark</a></p>)}
      <h2>View states</h2>{cases.filter(c => c.theme === 'light' && c.sidebar === 'expanded').map(c => <p key={c.id}>{c.owner} - {c.view} - {c.state}: {cases.filter(o => o.view === c.view && o.state === c.state).map(link)}</p>)}</main>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
