import React, { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { messageToThreadItem } from '../../v2/thread/useLiveThread';
import { BriefConversationClient } from './client';
import type { BriefReconciliationClient } from '../reconciliation/client';
import { useBriefReconciliation } from '../reconciliation/react';

function deviceStorage() { try { return window.localStorage; } catch { return undefined; } }

/** Mount once above rooms and themes. Children consume context and never open sockets. */
function useBriefLiveThread(client: BriefConversationClient, enabled: boolean, chatVisible: boolean, reconciliation?: BriefReconciliationClient) {
  const observer = useBriefReconciliation(reconciliation, enabled);
  const status = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const state = useSyncExternalStore(client.store.subscribe, client.store.getSnapshot, client.store.getSnapshot);
  useEffect(() => {
    if (enabled) void client.start();
    return () => client.stop();
  }, [client, enabled]);
  useEffect(() => {
    const update = () => client.store.setVisible(chatVisible && document.visibilityState === 'visible');
    update(); document.addEventListener('visibilitychange', update);
    return () => { document.removeEventListener('visibilitychange', update); client.store.setVisible(false); };
  }, [client, chatVisible]);
  useEffect(() => {
    if (enabled && chatVisible && status.mode === 'scoped' && status.connected && !state.activeId && !status.pending && !status.error)
      void client.ensureActive().catch(() => {});
  }, [client, enabled, chatVisible, status.mode, status.connected, status.pending, status.error, state.activeId]);
  const ws = useWebSocket({ enabled: enabled && (status.mode === 'scoped' || status.mode === 'legacy'),
    chat: status.mode === 'scoped' ? client.adapter : undefined, observer });
  // Everything but the chat itself passes through untouched (#1075): approvals,
  // clarifiers, repeat-backs, room actions and the room notifications share the
  // same connection, so mounting this in place of the dashboard hook hides none.
  // On a scoped socket the adapter swallows thinking and TTS frames, so
  // `thinking`, `voiceCallbacksRef` and voice over `wsRef` work in legacy mode only.
  const { messages: _messages, isConnected: _connected, sendMessage: _send, cancelResponse: _cancel, isResponding: _responding, ...socket } = ws;
  const current = state.activeId ? state.conversations[state.activeId] ?? null : null;
  const messages = status.mode === 'legacy' ? ws.messages : (current?.messages ?? []).map(row => ({
    id: row.id, role: row.role, content: row.content, timestamp: row.created_at, attachments: row.attachments,
    isStreaming: Object.values(current?.turns ?? {}).some(turn => turn.assistantMessageId === row.id && (turn.state === 'queued' || turn.state === 'running')),
  }));
  const items = messages.map(messageToThreadItem).filter(item => item !== null).map(({ __ts: _time, ...item }) => {
    const turn = status.mode === 'scoped' && Object.values(current?.turns ?? {}).find(turn => turn.assistantMessageId === item.id);
    if (item.kind === 'jarvis-speech' && turn && (turn.state === 'failed' || turn.state === 'cancelled')) {
      return { ...item, status: turn.state, error: turn.error?.message };
    }
    return item;
  });
  return {
    ...socket,
    status, state, current: status.mode === 'scoped' ? current : null, messages, items,
    isConnected: status.mode === 'scoped' ? status.connected : ws.isConnected,
    isResponding: status.mode === 'legacy' ? ws.isResponding : status.pendingSends.some(turn => turn.conversationId === state.activeId)
      || Object.values(current?.turns ?? {}).some(turn => turn.state === 'queued' || turn.state === 'running'),
    client,
    send: (text: string) => {
      if (status.mode === 'legacy') return ws.sendMessage(text);
      if (!state.activeId) throw new Error('Open a conversation before sending.');
      return client.send(state.activeId, text);
    },
    stopResponse: () => {
      if (status.mode === 'legacy') return ws.cancelResponse();
      const turn = Object.values(current?.turns ?? {}).find(turn => turn.state === 'queued' || turn.state === 'running')
        ?? status.pendingSends.find(turn => turn.conversationId === state.activeId);
      if (turn) client.cancel({ conversationId: turn.conversationId, turnId: turn.turnId, requestId: turn.requestId });
    },
  };
}
type BriefThread = ReturnType<typeof useBriefLiveThread>;
const BriefChatContext = createContext<BriefThread | null>(null);
export function BriefConversationProvider({ enabled = false, chatVisible = false, client: supplied, reconciliation, children }: {
  enabled?: boolean; chatVisible?: boolean; client?: BriefConversationClient; reconciliation?: BriefReconciliationClient; children: ReactNode;
}) {
  const [client] = useState(() => supplied ?? new BriefConversationClient(undefined, deviceStorage()));
  const thread = useBriefLiveThread(client, enabled, chatVisible, reconciliation);
  return <BriefChatContext.Provider value={thread}>{children}</BriefChatContext.Provider>;
}
export function useBriefConversation() {
  const value = useContext(BriefChatContext);
  if (!value) throw new Error('Mount BriefConversationProvider once above the Brief workspace.');
  return value;
}
