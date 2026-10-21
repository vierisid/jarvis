import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { GETTING_STARTED_IDS, isGettingStartedState, type GettingStartedChange, type GettingStartedId, type GettingStartedState } from '../../../../../src/brief/getting-started-contract';
import type { BriefRoute } from '../../contracts';
import type { HostTransport } from '../../host/http';
import { BriefButton, BriefIconButton } from '../../components/controls';
import './getting-started.css';

const steps: Record<GettingStartedId, { title: string; detail: string; room: BriefRoute['room'] }> = {
  goal: { title: 'Review your goal and key results', detail: 'Check that the plan reflects what you want to achieve.', room: 'goals' },
  authority: { title: 'Choose your default authority level', detail: 'Decide how much Jarvis can do. Keeping it low is a valid choice.', room: 'authority' },
  'governed-actions': { title: 'Choose which actions need approval', detail: 'Review Governed actions, including messages, files and purchases.', room: 'authority' },
  connections: { title: 'Check your connected workspace', detail: 'Review your device and connect only the services you need.', room: 'connected-workspace' },
  profile: { title: 'Make your profile yours', detail: 'Review the interview notes and add any missing preferences.', room: 'profile' },
  memory: { title: 'Explore what Jarvis remembers', detail: 'Review saved context. Correct or forget anything that is wrong.', room: 'memory' },
  workflow: { title: 'Review your first workflow', detail: 'Check its steps and connections, or create one if you skipped it.', room: 'all-workflows' },
  approvals: { title: 'Find where decisions wait for you', detail: 'Open Needs you to see where you review and approve work.', room: 'needs-you' },
  opportunities: { title: 'Discover your opportunities', detail: 'See where Jarvis brings routines worth turning into workflows.', room: 'opportunities' },
  preferences: { title: 'Set your dashboard preferences', detail: 'Choose your appearance and review the available voice settings.', room: 'settings' },
};
export function GettingStarted({ transport, navigate, goalId, compact = false }: {
  transport: HostTransport; navigate(route: BriefRoute): void; goalId?: string; compact?: boolean;
}) {
  const [state, setState] = useState<GettingStartedState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [expanded, setExpanded] = useState(false);
  const pending = useRef(false), lifetime = useRef<AbortController | null>(null);
  async function read(signal: AbortSignal) {
    try {
      const next = await transport.json('/api/brief/getting-started', { signal });
      if (!isGettingStartedState(next)) throw Error('Invalid checklist');
      if (!signal.aborted) { setState(next); setError(''); }
    } catch { if (!signal.aborted) setError('Your checklist could not be refreshed. Try again.'); }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    pending.current = false; setState(null); setError(''); setBusy(false); setExpanded(false);
    void read(controller.signal); return () => controller.abort();
  }, [transport]);
  async function save(change: GettingStartedChange) {
    if (!state || pending.current || error) return;
    const signal = lifetime.current!.signal;
    pending.current = true; setBusy(true);
    try {
      const next = await transport.json('/api/brief/getting-started', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: state.revision, change }), signal });
      if (!isGettingStartedState(next) || next.revision !== state.revision + 1) throw Error('Unconfirmed save');
      if (!signal.aborted) setState(next);
    } catch { if (!signal.aborted) setError('That change is not confirmed. Refresh the checklist before trying again.'); }
    finally { if (!signal.aborted) { pending.current = false; setBusy(false); } }
  }
  const count = state?.completed.length ?? 0;
  const collapsed = state && (state.hidden || (compact || count === 10) && !expanded);
  if (collapsed && !error) return <div className="brief-setup-resume"><BriefButton variant="text" icon={<ArrowRight size={16} />} disabled={busy} onClick={() => { if (state.hidden) void save({ hidden: false }); setExpanded(true); }}>
    {count === 10 ? 'Setup complete. Review checklist' : 'Continue setting up Jarvis'} · {count}/10
  </BriefButton></div>;
  const shown = expanded ? GETTING_STARTED_IDS : GETTING_STARTED_IDS.filter(id => !state?.completed.includes(id)).slice(0, 3);
  return <section className="brief-setup brief-surface" aria-label="Set up your workspace" aria-busy={busy || !state && !error || undefined}>
    <header><div><h2 className="brief-type-section-heading">Make Jarvis work for you.</h2>
      <p className="brief-type-body brief-secondary">Open a step, make it yours, then check it off here.</p></div>
      {state && <BriefIconButton icon={<X size={16} />} label="Hide setup checklist" disabled={busy || !!error} onClick={() => void save({ hidden: true })} />}
    </header>
    {state ? <><p className="brief-setup-count" role="status">{count} of 10 steps complete{busy ? ' · Saving…' : ''}</p>
      <ul>{shown.map(id => <li key={id} data-complete={state.completed.includes(id)}>
        <label className="brief-setup-check"><input type="checkbox" checked={state.completed.includes(id)} disabled={busy || !!error}
          aria-label={`Mark ${steps[id].title.toLowerCase()} ${state.completed.includes(id) ? 'incomplete' : 'complete'}`} onChange={e => void save({ item: id, done: e.currentTarget.checked })} /></label>
        <button className="brief-setup-open" aria-label={`Open: ${steps[id].title}`} onClick={() => navigate({ room: steps[id].room, selection: id === 'goal' && goalId ? { goalId } : {} })}>
          <span><strong>{steps[id].title}</strong><span className="brief-secondary">{steps[id].detail}</span></span><ArrowRight size={16} />
        </button>
      </li>)}</ul>
      <BriefButton variant="text" className="brief-setup-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? 'Show next steps' : 'Show all 10 steps'}</BriefButton></>
      : !error && <p className="brief-secondary">Loading your checklist…</p>}
    {error && <div role="alert" className="brief-setup-error"><p>{error}</p><BriefButton variant="secondary" onClick={() => void read(lifetime.current!.signal)}>Refresh checklist</BriefButton></div>}
  </section>;
}
