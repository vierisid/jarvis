import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../styles/globals.css';
import '../../../v2/v2.css';
import '../../../v2/ui/primitives.css';
import { OnboardingGate } from '../../../v2/onboarding/OnboardingGate';
import { OnboardingDraft, sessionOnboardingStorage } from '../draft';
import { BriefCapabilities } from '../../../../../src/brief/capabilities';
import { registerOnboarding } from '../../../../../src/brief/registrations/onboarding';
import type { BriefRoute } from '../../contracts';
import './preview.css';
function Preview() {
  const [route, setRoute] = useState<BriefRoute>({ room: 'today', selection: {} });
  const draft = useMemo(() => new OnboardingDraft('f26-synthetic-only', sessionOnboardingStorage('f26-synthetic-only', sessionStorage), {
    capabilities: () => new BriefCapabilities([
      ...registerOnboarding(() => ({ targets: true, progress: true, draftHandoff: true })),
      { id: 'workflowComposition', provider: { readiness: () => 'ready' } },
    ], ['onboarding', 'workflowComposition']).snapshot(),
    roomAvailable: () => true,
    canLeave: async signal => !signal.aborted, commit: setRoute,
  }), []);
  const reset = async (install: 'hosted' | 'local', phase: 'fresh' | 'replay', brief: boolean) => {
    await fetch('/fixture/reset', { method: 'POST', body: JSON.stringify({ install, phase }) });
    draft.clear();
    const href = new URL(brief ? '/?brief=1#/brief/today' : '/', location.href).href;
    if (href === location.href) location.reload(); else location.assign(href);
  };
  return <div className="jarvis-v2-root f26-fixture">
    <aside className="f26-fixture-toolbar" aria-label="Fixture controls">
      <strong>F-26 · isolated fixtures</strong>
      <button onClick={() => void reset('hosted', 'replay', true)}>Hosted replay</button>
      <button onClick={() => void reset('hosted', 'fresh', true)}>Hosted fresh</button>
      <button onClick={() => void reset('local', 'fresh', true)}>Local fresh</button>
      <button onClick={() => void reset('hosted', 'replay', false)}>Legacy replay</button>
      <button onClick={() => void fetch('/fixture/lose-response', { method: 'POST' })}>Lose next draft response</button>
      <button onClick={() => document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')}>Toggle theme</button>
    </aside>
    <OnboardingGate brief={draft}>
      <main className="f26-fixture-result"><h1>{route.room === 'workflow-draft' ? 'Draft review destination' : 'Dashboard destination'}</h1>
        <p>Synthetic receipt. This fixture does not call a model, run a workflow, connect a service or grant authority.</p>
        <pre>{JSON.stringify(route, null, 2)}</pre><p>Production F-07 persistence is verified separately by the SQLite integration test.</p>
      </main>
    </OnboardingGate>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
