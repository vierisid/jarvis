import React, { Component, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useTheme } from '../../v2/shell/useTheme.ts';
import type { Session } from './session.ts';
import './host.css';

class ViewBoundary extends Component<{ children: ReactNode; recover: () => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <Recovery retry={() => { this.props.recover(); this.setState({ failed: false }); }} /> : this.props.children; }
}
function Recovery({ retry }: { retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="on-host__recovery" aria-labelledby="on-host-unavailable">
    <h1 id="on-host-unavailable" tabIndex={-1} ref={heading}>Let’s reconnect.</h1>
    <p role="status">Onboarding is unavailable. Your saved progress is retained. Reconnect to check what completed before trying again.</p>
    <button type="button" onClick={retry}>Reconnect</button>
  </section>;
}
/** Only local, trusted adapter render ports cross this boundary. No JSON can
 * select a component, callback, capability, account or project. */
export function ViewHost({ session, legacy, children }: { session: Session; legacy: ReactNode; children: ReactNode }) {
  const state = useSyncExternalStore(session.subscribe, session.state, session.state);
  const [theme, setTheme] = useTheme();
  const headingHost = useRef<HTMLDivElement>(null);
  const focusedView = useRef<string | null>(null);
  useEffect(() => {
    if (state.mode !== 'checking') window.dispatchEvent(new Event('jarvis:boot-ready'));
  }, [state.mode]);
  useEffect(() => {
    if (state.blocked) { focusedView.current = null; return; }
    if (state.busy || !state.view || focusedView.current === state.view) return;
    focusedView.current = state.view;
    const heading = [...(headingHost.current?.querySelectorAll<HTMLElement>('h1,h2') ?? [])].find(node => !node.closest('[inert]'));
    if (heading && !headingHost.current?.contains(document.activeElement)) { heading.tabIndex = -1; heading.focus(); }
  }, [state.view, state.blocked, state.busy]);
  useEffect(() => {
    const refresh = () => { void session.refresh(); };
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('v2-onboarding-status');
    if (channel) channel.onmessage = refresh;
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); channel?.close(); };
  }, [session]);
  if (state.mode === 'legacy') return <>{legacy}</>;
  if (state.mode === 'complete') return <>{children}</>;
  if (state.mode === 'checking' || !state.journey || !state.view) return state.blocked ? <Recovery retry={() => void session.refresh()} /> : <p className="on-host__loading" role="status">Restoring onboarding…</p>;
  const key = session.key();
  const action = (name: string, input?: unknown) => session.act(key, name, input);
  const intent = (value: unknown) => {
    if (!value || typeof value !== 'object' || typeof (value as { action?: unknown }).action !== 'string') return Promise.resolve();
    return action((value as { action: string }).action, value);
  };
  const draft = (value: unknown) => { void session.draft(key, value); };
  const navigation = { kind: state.busy ? 'pending' : 'ready', message: state.busy ? 'Saving your progress…' : '', revision: state.journey.revision };
  const base = state.presentation?.model ?? {};
  const model = { ...base, theme };
  let props: Record<string, unknown> = { ...state.presentation?.ports, model };
  switch (state.view) {
    case 'welcome': props = { model: { theme, installMode: session.installMode(), state: navigation }, onSetUp: () => action('continue'), onExit: () => action('explore'), onThemeChange: setTheme }; break;
    case 'explainer': props = { model: { theme, state: navigation }, onBack: () => action('back'), onContinue: () => action('continue') }; break;
    case 'google': props = { ...props, model: { ...model, navigation }, onConnect: () => action('connect'), onCancel: (attemptId: string) => action('cancel', { attemptId }), onBack: () => action('back'), onSkip: () => action('skip'), onContinue: () => action('continue') }; break;
    case 'interview': props = { ...props, model: { ...model, navigation }, onDraftChange: draft, onSubmit: (answer: unknown) => action('answer', answer), onRetry: (recovery: unknown) => action('retry', recovery), onSkip: () => action('skip'), onContinue: () => action('continue') }; break;
    case 'tour': case 'pebble-tour': props = { ...props, onNavigate: intent }; break;
    case 'activation': props = { ...props, onDraftChange: draft, onIntent: intent }; break;
    case 'build': props = { ...props, model: { ...model, actions: { ...(base.actions as Record<string, unknown>), openResult: !state.busy && (base.actions as Record<string, unknown>)?.openResult === true } }, onIntent: intent }; break;
    case 'result': props = { ...props, onReview: () => action('review'), onContinue: () => action('finish') }; break;
    case 'legacy-provider-setup': props = { ...props, onComplete: () => action('complete'), onBack: () => action('back') }; break;
  }
  const View = state.view === 'legacy-provider-setup' ? state.presentation?.ports?.View as ComponentType<Record<string, unknown>> : session.views()?.[state.view];
  return <div className="on-host" data-theme={theme} data-onboarding-step={state.view} ref={headingHost}>
    {state.blocked ? <Recovery retry={() => void session.refresh()} /> : <ViewBoundary key={`${state.journey.journeyId}:${state.view}`} recover={() => void session.refresh()}>
      <div aria-busy={state.busy} inert={state.busy}>{View ? <View {...props} /> : <Recovery retry={() => void session.refresh()} />}</div>
    </ViewBoundary>}
  </div>;
}
