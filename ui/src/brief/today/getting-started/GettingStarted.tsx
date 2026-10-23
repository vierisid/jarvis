import React, { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { GETTING_STARTED_IDS, isGettingStartedState, type GettingStartedChange, type GettingStartedId, type GettingStartedState } from '../../../../../src/brief/getting-started-contract';
import type { BriefRoute, BriefRoomRegistry, BriefShellPort } from '../../contracts';
import type { HostTransport } from '../../host/http';
import { BriefButton } from '../../components/controls';
import { useBriefMotion } from '../../motion';
import '../hero-paper/hero-paper.css';
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

interface JourneyView { state: GettingStartedState | null; active: GettingStartedId | null; busy: boolean; error: string }
/** One owner spans Today and destination rooms. Progress is a server acknowledgement. */
export class GettingStartedJourney {
  private view: JourneyView = { state: null, active: null, busy: false, error: '' };
  private listeners = new Set<() => void>();
  private life = new AbortController();
  private reading: Promise<void> | null = null;
  private storageKey: string;
  constructor(private transport: HostTransport, private storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, scope = '') {
    this.storageKey = `brief:setup-review:v1:${scope}`;
    try { const saved = storage?.getItem(this.storageKey); if (GETTING_STARTED_IDS.includes(saved as GettingStartedId)) this.view.active = saved as GettingStartedId; } catch {}
  }
  snapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<JourneyView>) { if (this.life.signal.aborted) return; this.view = { ...this.view, ...patch }; this.listeners.forEach(fn => fn()); }
  read = () => {
    if (this.life.signal.aborted || this.view.busy) return Promise.resolve();
    if (this.reading) return this.reading;
    this.reading = (async () => {
      try {
        const state = await this.transport.json('/api/brief/getting-started', { signal: this.life.signal });
        if (!isGettingStartedState(state)) throw Error('Invalid setup progress');
        this.update({ state, error: '' });
      } catch { this.update({ error: 'Your setup actions could not be refreshed. Try again.' }); }
      finally { this.reading = null; }
    })();
    return this.reading;
  };
  start(id: GettingStartedId) {
    if (!this.view.state || this.view.busy || this.view.error || this.view.state.completed.includes(id)) return false;
    try { this.storage?.setItem(this.storageKey, id); } catch {}
    this.update({ active: id }); return true;
  }
  clear() { try { this.storage?.removeItem(this.storageKey); } catch {} this.update({ active: null }); }
  async save(change: GettingStartedChange) {
    if (this.reading) await this.reading;
    const state = this.view.state;
    if (this.life.signal.aborted || !state || this.view.busy || this.view.error) return false;
    this.update({ busy: true });
    try {
      const next = await this.transport.json('/api/brief/getting-started', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: state.revision, change }), signal: this.life.signal });
      if (!isGettingStartedState(next) || next.revision !== state.revision + 1) throw Error('Unconfirmed save');
      if (this.life.signal.aborted) return false;
      this.update({ state: next }); return true;
    } catch { this.update({ error: 'That action is not confirmed. Refresh before trying again.' }); return false; }
    finally { this.update({ busy: false }); }
  }
  async complete(id: GettingStartedId) {
    if (this.view.active !== id) return false;
    const ok = this.view.state?.completed.includes(id) || await this.save({ item: id, done: true });
    if (ok && !this.life.signal.aborted) { this.clear(); return true; } return false;
  }
  retire() { this.life.abort(); this.listeners.clear(); }
}
function useJourney(journey: GettingStartedJourney) {
  const view = useSyncExternalStore(journey.subscribe, journey.snapshot, journey.snapshot);
  useEffect(() => { void journey.read(); }, [journey]);
  return view;
}
function Recovery({ journey, error }: { journey: GettingStartedJourney; error: string }) {
  return error ? <div role="alert" className="brief-setup-error"><p>{error}</p><BriefButton variant="secondary" onClick={() => void journey.read()}>Refresh setup actions</BriefButton></div> : null;
}
export function GettingStarted({ journey, navigate, goalId, compact = false }: {
  journey: GettingStartedJourney; navigate(route: BriefRoute): void; goalId?: string; compact?: boolean;
}) {
  const { state, busy, error } = useJourney(journey);
  const [expanded, setExpanded] = useState(false);
  const count = state?.completed.length ?? 0;
  const id = GETTING_STARTED_IDS.find(id => !state?.completed.includes(id));
  const open = () => { if (id && journey.start(id)) navigate({ room: steps[id].room, selection: id === 'goal' && goalId ? { goalId } : {} }); };
  if (state && (state.hidden || compact && !expanded) && !error) return <div className="brief-setup-resume"><BriefButton variant="text" icon={<ArrowRight size={16} />} disabled={busy} onClick={() => { if (state.hidden) void journey.save({ hidden: false }); setExpanded(true); }}>Continue setting up Jarvis · {count}/10</BriefButton></div>;
  return <div className="brief-setup-sequence">
    {!state ? <section className="brief-today-decision brief-today-decision--fallback" aria-busy={!error || undefined}><h2 className="brief-type-hero-heading">{error ? 'Setup actions unavailable.' : 'Loading your next setup action…'}</h2></section>
      : id ? <SetupPaper key={id} id={id} count={count} disabled={busy || !!error} open={open} />
      : <section className="brief-today-decision brief-today-decision--fallback"><h2 className="brief-type-hero-heading">You’re ready to make room for your work.</h2><p className="brief-type-body brief-secondary">All 10 setup actions complete. Your next decision will appear here.</p></section>}
    <Recovery journey={journey} error={error} />
    {state && <div className="brief-setup-controls"><span role="status" className="brief-type-utility brief-secondary">{count} of 10 setup actions complete{busy ? ' · Saving…' : ''}</span>
      {count > 0 && <BriefButton variant="text" size="sm" disabled={busy || !!error} onClick={() => void journey.save({ item: state.completed.at(-1)!, done: false })}>Undo last action</BriefButton>}
      {id && <BriefButton variant="text" size="sm" disabled={busy || !!error} onClick={() => void journey.save({ hidden: true })}>Hide setup actions</BriefButton>}
    </div>}
  </div>;
}
const pageNames: Record<GettingStartedId, string> = { goal: 'Goals', authority: 'Authority', 'governed-actions': 'Authority', connections: 'Connected workspace', profile: 'Profile', memory: 'Memory', workflow: 'Workflows', approvals: 'Needs you', opportunities: 'Opportunities', preferences: 'Settings' };
const guidance: Record<GettingStartedId, string> = {
  goal: 'Open your objective, read its key results and follow the milestones that lead to it.',
  authority: 'Review the default level and what it permits. Choose the amount of control that feels right for you.',
  'governed-actions': 'Find Governed actions. Check the approval rules for sending messages, changing files and spending money.',
  connections: 'Check which devices are online and which services Jarvis can reach. Add a connection only when you need it.',
  profile: 'Read the context saved from your interview. Edit your preferences and save any corrections.',
  memory: 'Browse the context Jarvis has saved. Open an item to inspect its source or correct it.',
  workflow: 'Open your workflow in the library and review its steps. It can stay a draft while you make it yours.',
  approvals: 'This is where work waits for your decision. An empty queue means there is nothing to approve yet.',
  opportunities: 'Jarvis brings useful routines here for your review. You decide which ones should become workflows.',
  preferences: 'Choose light or dark appearance and review the voice options available to your workspace.',
};
function SetupPaper({ id, count, disabled, open }: { id: GettingStartedId; count: number; disabled: boolean; open(): void }) {
  const [hover, setHover] = useState(false), [focus, setFocus] = useState(false), [details, setDetails] = useState(false);
  const raised = hover || focus || details;
  const review = useRef<HTMLButtonElement>(null);
  const paper = useBriefMotion<HTMLDivElement>({ transform: raised ? 'translate(-12px, -6px) rotate(-0.8deg)' : 'translate(26px, 12px) rotate(-3.5deg)' }, { kind: 'reveal', active: raised });
  const actions = useBriefMotion<HTMLDivElement>({ opacity: raised ? 1 : 0 }, { kind: 'reveal', active: raised });
  return <section className="brief-today-decision brief-setup-hero" aria-label="Next setup action" data-step={id}
    onPointerEnter={e => { if (e.pointerType !== 'touch') setHover(true); }} onPointerLeave={() => setHover(false)}
    onFocus={e => { if (e.target.matches(':focus-visible')) setFocus(true); }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false); }}
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setDetails(false); setHover(false); setFocus(false); review.current?.focus(); } }}>
    <div className="brief-today-decision-summary">
      <div className="brief-today-decision-meta"><span className="brief-status brief-status--attention">Make it yours</span><span className="brief-type-utility brief-secondary">{10-count} {count === 9 ? 'action' : 'actions'}</span></div>
      <h2 className="brief-type-hero-heading">{steps[id].title}.</h2>
      <p className="brief-type-body brief-secondary">{steps[id].detail}</p>
      <BriefButton ref={review} className="brief-today-review-trigger" variant="primary" aria-expanded={details} onClick={() => setDetails(!details)}>Review setup action</BriefButton>
    </div>
    <div className="brief-today-paper-stage" data-raised={raised}>
      <div className="brief-today-paper-recess" aria-hidden="true" />
      <div className="brief-today-paper-clip" data-raised={raised}>
        <div className="brief-today-paper-backing-mask" aria-hidden="true"><div className="brief-today-paper-backs">{count < 8 && <span className="brief-today-paper-back far" />}{count < 9 && <span className="brief-today-paper-back" />}</div></div>
        <div ref={paper} className="brief-today-paper-motion"><article className="brief-today-paper-face" aria-label={`${pageNames[id]} setup`}>
          <h3 className="brief-type-body-emphasis">{pageNames[id]}</h3>
          <div className="brief-today-paper-excerpt"><p className="brief-type-body">{guidance[id]}</p><p className="brief-today-document-attention brief-type-body">When you’ve reviewed the page, choose “Done, back to Today” to continue.</p></div>
          <div ref={actions} className="brief-today-paper-actions" inert={!raised} aria-hidden={!raised}><BriefButton variant="primary" size="sm" disabled={disabled} onClick={open}>Open {pageNames[id]}</BriefButton></div>
        </article></div>
      </div>
    </div>
  </section>;
}
/** Review stays on the real page; completion is explicit and respects unsaved edits. */
export function GettingStartedDestination({ journey, shell, canLeave, returnToToday, children }: {
  journey: GettingStartedJourney; shell: BriefShellPort; canLeave(signal: AbortSignal): Promise<boolean>; returnToToday?(): void; children: ReactNode;
}) {
  const { state, active, busy, error } = useJourney(journey);
  const leaving = useRef(false), life = useRef(new AbortController());
  const [checking, setChecking] = useState(false), [navigationError, setNavigationError] = useState('');
  useEffect(() => { const controller = new AbortController(); life.current = controller; return () => controller.abort(); }, []);
  const matches = active && (steps[active].room === shell.route.room || active === 'workflow' && ['workflow','workflow-preview','workflow-draft','workflow-context','workflow-runs'].includes(shell.route.room) || active === 'memory' && shell.route.room === 'memory-detail');
  async function finish(complete = true) {
    if (!active || leaving.current || busy || complete && error) return;
    leaving.current = true; setChecking(true); setNavigationError(''); const signal = life.current.signal;
    try {
      if (!await canLeave(signal) || signal.aborted) return;
      if (complete && !await journey.complete(active) || signal.aborted) return;
      if (!complete) journey.clear();
      if (returnToToday) returnToToday(); else shell.navigate({ room: 'today', selection: {} });
    } catch { if (!signal.aborted) setNavigationError('Could not return to Today. Save any changes, then try again.'); }
    finally { leaving.current = false; if (!signal.aborted) setChecking(false); }
  }
  return <>{matches && state && <section className="brief-setup-destination brief-surface" aria-label="Current setup action">
    <div><strong>{steps[active].title}</strong><p className="brief-type-utility brief-secondary">Review this page and save any changes before continuing.</p></div>
    <BriefButton variant="primary" disabled={busy || checking || !!error} onClick={() => void finish()}>{busy || checking ? 'Finishing…' : 'Done, back to Today'}</BriefButton>
    <BriefButton variant="text" disabled={busy || checking} onClick={() => void finish(false)}>Back without completing</BriefButton>
    <Recovery journey={journey} error={error} />
    {navigationError && <p role="alert">{navigationError}</p>}
  </section>}{children}</>;
}
export function withGettingStarted(rooms: BriefRoomRegistry, journey: GettingStartedJourney, canLeave: (signal: AbortSignal) => Promise<boolean>, enabled: () => boolean, returnToToday: () => void): BriefRoomRegistry {
  return Object.fromEntries(Object.entries(rooms).map(([id, room]) => {
    const Body = room!.Body!;
    return [id, id === 'today' ? room : { ...room, Body: ({ shell }: { shell: BriefShellPort }) => enabled()
      ? <GettingStartedDestination journey={journey} shell={shell} canLeave={canLeave} returnToToday={returnToToday}><Body shell={shell} /></GettingStartedDestination> : <Body shell={shell} /> }];
  }));
}
