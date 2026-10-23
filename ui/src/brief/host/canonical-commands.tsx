import { confirmDialog } from '../../v2/ui/ConfirmDialog';
import { inputDialog } from './InputDialog';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import type { QueuedDecision, DecisionAction } from '../../../../src/brief/decision-contracts';
import { isBriefCapabilityEnabled } from '../../../../src/brief/capabilities';
import type { MemoryDetailController } from '../memory/detail/controller';
import { BriefButton } from '../components/controls';
import { post, type HostTransport } from './http';
import type { BriefRoute } from '../contracts';
import '../decisions/decisions.css';
import './host.css';

const labels: Record<DecisionAction, string> = { accept_intent: 'Accept next step', reject_intent: 'Reject next step',
  approve_permission: 'Grant permission', reject_permission: 'Deny permission', execute_once: 'Execute once', close_without_running: 'Close without running', inspect: 'Inspect' };
/** Non-document F12 decisions retain their own action and result contract. */
export function PendingDecisions({ http, read, enabled, changed, selection, navigate }: { selection?: string; navigate?(route: BriefRoute): void; http: HostTransport; read(): Promise<QueuedDecision[]>; enabled: boolean; changed(): void }) {
  const [rows, setRows] = useState<QueuedDecision[] | null>(null), [message, setMessage] = useState(''), [pending, setPending] = useState(false), [epoch, refresh] = useState(0);
  const [selected, select] = useState<string | null>(null);
  const list = React.useRef<HTMLElement>(null), restoreFocus = React.useRef(false);
  useEffect(() => {
    if (restoreFocus.current && rows) {
      list.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
      restoreFocus.current = false;
    }
  }, [rows]);
  useEffect(() => { if (selection) select('approval:' + selection); }, [selection]);
  useEffect(() => {
    let alive = true, reading = false;
    const load = async () => { if (!enabled || reading) return; reading = true;
      try { const next = await read(); if (alive) setRows(next); }
      catch { if (alive) { setRows(null); setMessage('Decision status is unavailable. Reconnect before acting.'); } }
      finally { reading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled, epoch]);
  const act = async (row: QueuedDecision, action: DecisionAction) => {
    if (pending || !enabled || action === 'inspect') return;
    setPending(true);
    try {
      const intent = action === 'accept_intent' || action === 'reject_intent';
      const reason = intent ? await inputDialog('Reason for this decision', '', http.signal) : null;
      if (intent && !reason?.trim()) return;
      if (action === 'execute_once' && !await confirmDialog(`Execute this action once: ${row.title}?`)) return;
      const result = await http.json(`/api/brief/decisions/${encodeURIComponent(row.decisionId)}/resolve`, post({ revision: row.revision, action, ...(intent ? { reason } : {}) }));
      if (result.decisionId !== row.decisionId || typeof result.state !== 'string' || typeof result.revision !== 'string') throw Error();
      setMessage(`Decision updated: ${result.state.replaceAll('_', ' ')}.`); restoreFocus.current = true; changed(); refresh(n => n + 1);
    } catch { setMessage('Outcome is unconfirmed. Recheck the saved decision before making another choice.'); setRows(null); }
    finally { setPending(false); }
  };
  if (!enabled) return null;
  const row = rows?.find(r => r.decisionId === selected) ?? rows?.[0];
  const title = (r: QueuedDecision) => ({ browser_navigate: 'Open a browser page', browser_snapshot: 'Read the browser page',
    browser_screenshot: 'View the browser', browser_click: 'Interact with the browser', browser_scroll: 'Scroll the browser page' }[r.review?.toolName ?? ''] ?? r.title);
  const actions = row?.supportedActions.filter(a => a !== 'inspect') ?? [];
  const primary = actions.find(a => ['approve_permission', 'accept_intent', 'execute_once'].includes(a));
  return <section className="brief-host-pending" aria-label="Other decisions">
    {row && <div className="brief-decisions-grid">
      <nav ref={list} className="brief-decision-list" aria-label="Requests to review">
        {rows?.map(item => <button key={item.decisionId} className="brief-decision-choice" type="button"
          aria-pressed={item.decisionId === row.decisionId} disabled={pending} onClick={() => select(item.decisionId)}>
          <span><strong>{title(item)}</strong></span><span className="brief-decision-recipient">{item.workflow ? 'Workflow request' : 'Jarvis request'}</span>
          <span className="brief-decision-hint">{item.review?.origin ?? (item.kind === 'permission' ? 'Your permission is needed to continue.' : item.state.replaceAll('_', ' '))}</span>
          <small>{item.decisionId === row.decisionId ? 'Selected' : 'Review request'}</small>
        </button>)}
      </nav>
      <article className="brief-decision-paper" aria-label="Selected request">
        <header className="brief-decision-title"><h2 className="brief-type-hero-heading">{title(row)}</h2>
          <span className="brief-decision-badge">{actions.length ? 'Needs your review' : row.state.replaceAll('_', ' ')}</span></header>
        <div className="brief-decision-context"><span>{row.workflow ? 'Workflow request' : 'Jarvis request'}</span>
          {row.run && navigate && <BriefButton size="sm" onClick={() => navigate({ room: 'workflow-runs', selection: { flowId: row.run!.flowId, versionId: row.run!.versionId, runId: row.run!.runId } })}>Open workflow</BriefButton>}</div>
        <div className="brief-decision-document">
          {row.review?.origin && <p><strong>Website</strong><br />{row.review.origin}</p>}
          {row.review?.target && <p><strong>Computer</strong><br />{row.review.target}</p>}
          <p>{row.kind === 'permission' ? 'Jarvis needs your permission for this action before it can continue.' : row.title}</p>
          {row.review?.toolName.startsWith('browser_') && <p>The browser uses a separate Jarvis profile. If the site asks you to sign in, complete sign-in in that browser before starting a new run.</p>}
          {row.kind === 'permission' && <p>Allowing this request does not change your Authority settings or confirm that the workflow has completed.</p>}
          <details className="brief-host-request-details"><summary>Request details</summary><p>{row.title}</p>
            {row.review?.reason && row.review.reason !== row.title && <p>{row.review.reason}</p>}</details>
        </div>
        <footer className="brief-decision-bottom"><div className="brief-decision-actions">
          {[...actions.filter(a => a !== primary), ...(primary ? [primary] : [])].map(action => <BriefButton key={action}
            variant={action === primary ? 'primary' : 'ghost'} disabled={pending} onClick={() => void act(row, action)}>{labels[action]}</BriefButton>)}
        </div></footer>
      </article>
    </div>}
    {message && <p role="status">{message}</p>}{rows === null && <BriefButton disabled={pending} onClick={() => refresh(n => n + 1)}>Recheck decisions</BriefButton>}
  </section>;
}
/** F19 deletes only after a fresh scoped revision and explicit local confirmation. */
export function ForgetMemory({ detail, http, capabilities, storage, scopeId, changed }: { detail: MemoryDetailController; http: HostTransport;
  capabilities: unknown; storage: Pick<Storage, 'setItem'>; scopeId: string; changed(): void }) {
  const state = useSyncExternalStore(detail.subscribe, detail.snapshot, detail.snapshot), [pending, setPending] = useState(false), [message, setMessage] = useState('');
  const item = state.read.state === 'ready' ? state.read.data.item : null;
  useEffect(() => setMessage(''), [state.factId]);
  const forget = async () => {
    if (!item || pending || !detail.canLeave()) return;
    setPending(true);
    try {
      const path = `/api/brief/memory/${encodeURIComponent(item.factId)}`;
      const source = await http.json(path + '/forget'), current = await http.json(path);
      if (source.state !== 'ready' || source.factId !== item.factId || current.state !== 'ready' || current.data.revision !== item.revision) throw Error();
      if (!await confirmDialog(`Forget this memory: “${item.sentence}”?\n\nThis removes the selected fact and its evidence from future recall. Original messages, source documents, other facts and backups remain.`)) return;
      const command = { requestId: crypto.randomUUID(), expectedRevision: source.revision, confirmed: true };
      storage.setItem(`brief:forget:v1:${scopeId}:${item.factId}`, JSON.stringify(command));
      const result = await http.json(path + '/forget', post(command));
      if (result.state !== 'forgotten' || result.receipt?.factId !== item.factId || result.receipt.requestId !== command.requestId || result.receipt.revision !== source.revision) throw Error();
      setMessage('Memory forgotten. Original messages and source documents remain.'); changed(); await detail.reload();
    } catch { setMessage('Could not confirm forgetting. Reload the fact to check its current state.'); }
    finally { setPending(false); }
  };
  return <div>{item?.permissions.canForget && isBriefCapabilityEnabled(capabilities, 'memoryForget') && !state.panel && <BriefButton disabled={pending} onClick={() => void forget()}>Forget this memory</BriefButton>}{message && <p role="status">{message}</p>}</div>;
}
