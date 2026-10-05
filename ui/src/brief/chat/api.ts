import type { BriefConversation, BriefPage } from '../../../../src/brief/contracts';
import type { ConversationMessage } from '../../../../src/vault/conversations';
import type { ConversationTabs } from '../../../../src/vault/conversation-lifecycle';

export class ChatApiError extends Error {
  constructor(readonly status: number) { super(`Conversation request failed (${status}).`); }
}
export interface ConversationApi {
  capabilities(signal: AbortSignal): Promise<unknown>;
  tabs(signal: AbortSignal): Promise<ConversationTabs>;
  create(signal: AbortSignal): Promise<BriefConversation>;
  tab(id: string, open: boolean, signal: AbortSignal): Promise<BriefConversation>;
  select(id: string | null, signal: AbortSignal): Promise<ConversationTabs>;
  history(id: string, cursor: string | null, signal: AbortSignal): Promise<BriefPage<ConversationMessage>>;
}
export function conversationApi(fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)): ConversationApi {
  const base = '/api/brief/conversations';
  const request = async (path: string, signal: AbortSignal, method = 'GET', body?: unknown) => {
    const response = await fetcher(path, { signal, method, credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new ChatApiError(response.status);
    return response.json();
  };
  const conversation = (value: unknown): BriefConversation => {
    if (!isConversation(value)) throw new Error('Invalid conversation response.');
    return value;
  };
  const tabs = (value: unknown): ConversationTabs => {
    const v = value as ConversationTabs;
    if (!v || typeof v.workspaceId !== 'string' || typeof v.revision !== 'string'
      || !(v.activeConversationId === null || typeof v.activeConversationId === 'string')
      || !Array.isArray(v.tabs) || v.tabs.length > 50 || !v.tabs.every(c => isConversation(c) && c.workspaceId === v.workspaceId && c.tab.open)
      || new Set(v.tabs.map(c => c.conversationId)).size !== v.tabs.length
      || (v.activeConversationId !== null && !v.tabs.some(c => c.conversationId === v.activeConversationId))) throw new Error('Invalid conversation tabs response.');
    return v;
  };
  return {
    capabilities: signal => request('/api/brief/capabilities', signal),
    tabs: async signal => tabs(await request(`${base}/tabs`, signal)),
    create: async signal => conversation(await request(base, signal, 'POST', {})),
    tab: async (id, open, signal) => conversation(await request(`${base}/${encodeURIComponent(id)}/tab`, signal, 'PATCH', { open })),
    select: async (id, signal) => tabs(await request(`${base}/active`, signal, 'PUT', { conversationId: id })),
    history: async (id, cursor, signal) => {
      const page = await request(`${base}/${encodeURIComponent(id)}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal);
      if (!isMessagePage(page, id)) throw new Error('Invalid conversation history response.');
      return page;
    },
  };
}
function isConversation(value: unknown): value is BriefConversation {
  const v = value as BriefConversation;
  return !!v && typeof v.conversationId === 'string' && v.conversationId.length > 0 && typeof v.workspaceId === 'string'
    && typeof v.title === 'string' && typeof v.revision === 'string' && !!v.tab && typeof v.tab.open === 'boolean' && Number.isSafeInteger(v.tab.order);
}
export function isMessagePage(value: unknown, id: string): value is BriefPage<ConversationMessage> {
  const v = value as BriefPage<ConversationMessage>;
  return !!v && (v.nextCursor === null || typeof v.nextCursor === 'string') && Array.isArray(v.items) && v.items.every(row => row
    && row.conversation_id === id && typeof row.id === 'string' && ['user', 'assistant', 'system'].includes(row.role)
    && typeof row.content === 'string' && Number.isFinite(row.created_at));
}
