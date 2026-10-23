import { confirmDialog } from '../../v2/ui/ConfirmDialog';
import { inputDialog } from './InputDialog';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import type { QueuedDecision, DecisionAction } from '../../../../src/brief/decision-contracts';
import { isBriefCapabilityEnabled } from '../../../../src/brief/capabilities';
import type { MemoryDetailController } from '../memory/detail/controller';
import { BriefButton } from '../components/controls';
import { post, type HostTransport } from './http';

const labels: Record<DecisionAction, string> = { accept_intent: 'Accept next step', reject_intent: 'Reject next step',
  approve_permission: 'Grant permission', reject_permission: 'Deny permission', execute_once: 'Execute once', close_without_running: 'Close without running', inspect: 'Inspect' };
/** Non-document F12 decisions retain their own action and result contract. */
export function PendingDecisions({ http, read, enabled, changed }: { http: HostTransport; read(): Promise<QueuedDecision[]>; enabled: boolean; changed(): void }) {
  const [rows, setRows] = useState<QueuedDecision[] | null>(null), [message, setMessage] = useState(''), [pending, setPending] = useState(false), [epoch, refresh] = useState(0);
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
      setMessage(`Decision updated: ${result.state.replaceAll('_', ' ')}.`); changed(); refresh(n => n + 1);
    } catch { setMessage('Outcome is unconfirmed. Recheck the saved decision before making another choice.'); setRows(null); }
    finally { setPending(false); }
  };
  if (!enabled) return null;
  return <section className="brief-host-pending" aria-label="Other decisions">
    {rows?.map(row => <article key={row.decisionId}><h2>{row.title}</h2><p>{row.kind} · {row.state.replaceAll('_', ' ')}</p>
      {row.supportedActions.filter(action => action !== 'inspect').map(action => <BriefButton key={action} disabled={pending} onClick={() => void act(row, action)}>{labels[action]}</BriefButton>)}
    </article>)}
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
