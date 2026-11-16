import React, { useEffect, useId, useRef, useState } from 'react';
import type { BriefConversation } from '../../../../src/brief/contracts';
import type { BriefConversationClient } from '../chat/client';
import { ChatApiError } from '../chat/api';
import './closed-chats.css';

export function ClosedChats({ client, openIds, busy }: {
  client: Pick<BriefConversationClient, 'listClosed' | 'reopen'>; openIds: readonly string[]; busy: boolean;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false), [rows, setRows] = useState<BriefConversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [pending, setPending] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null), mounted = useRef(true), lock = useRef(false);
  const seen = useRef(new Set<string>()), openKey = JSON.stringify(openIds);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  async function load(after: string | null) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    if (!after) { setRows([]); setCursor(null); seen.current.clear(); }
    try {
      const page = await client.listClosed(after, controller.signal);
      if (controller.signal.aborted) return;
      if (page.nextCursor && (page.nextCursor === after || seen.current.has(page.nextCursor))) throw new Error('Repeated cursor');
      if (after) seen.current.add(after);
      setRows(previous => [...new Map([...(after ? previous : []), ...page.items].map(row => [row.conversationId, row])).values()]);
      setCursor(page.nextCursor);
    } catch { if (!controller.signal.aborted) setError('Closed chats could not be loaded. Try again.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => { if (expanded) void load(null); return () => request.current?.abort(); }, [expanded, openKey, client]);
  async function reopen(conversationId: string) {
    if (lock.current || busy) return;
    lock.current = true; setPending(conversationId); setError('');
    try {
      await client.reopen(conversationId);
      if (mounted.current) { setExpanded(false); trigger.current?.focus(); }
    } catch (failure) {
      // 409 is the open-tab limit: retrying cannot help until another chat is closed.
      if (mounted.current) setError(failure instanceof ChatApiError && failure.status === 409
        ? 'Too many chats are open. Close one, then reopen this chat.' : 'This chat could not be reopened. Try again.');
    }
    finally { lock.current = false; if (mounted.current) setPending(null); }
  }
  return <div className="brief-closed-chats">
    <button type="button" ref={trigger} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>Reopen a closed chat</button>
    {expanded && <section id={id} aria-label="Closed chats" aria-busy={loading}>
      <p>Reopen a chat to continue where you left off.</p>
      <ul>{rows.map(row => <li key={row.conversationId}><button type="button" disabled={busy || pending !== null}
        aria-label={`Reopen ${row.title}`} onClick={() => void reopen(row.conversationId)}>
        <span>{row.title}</span><span>{pending === row.conversationId ? 'Opening…' : 'Reopen'}</span>
      </button></li>)}</ul>
      <p role="status">{error || (loading ? 'Loading closed chats…' : !rows.length ? 'No closed chats.' : '')}</p>
      {error && !pending && <button type="button" disabled={loading} onClick={() => void load(cursor)}>Reload closed chats</button>}
      {cursor && !error && <button type="button" disabled={loading} onClick={() => void load(cursor)}>Load more</button>}
    </section>}
  </div>;
}
