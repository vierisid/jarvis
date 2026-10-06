/** Structural F-04 port. Persistence, send acceptance and cancellation remain with its owner. */
export interface ComposerTurn { conversationId: string; turnId: string; requestId: string }
export interface ComposerOwner {
  status: { mode: "disabled" | "loading" | "scoped" | "legacy" | "unavailable"; connected: boolean; pending: number; pendingSends: readonly ComposerTurn[] };
  state: { workspaceId: string | null; activeId: string | null; order: readonly string[]; conversations: Readonly<Record<string, {
    draft: string; error: string | null; turns: Readonly<Record<string, ComposerTurn & { state: string }>>;
  }>> };
  client: { store: { setDraft(id: string, text: string): void; dismissError(id: string): void }; send(id: string, text: string): unknown; cancel(ref: ComposerTurn): unknown };
}
export interface ComposerBinding {
  source: "live" | "fixture";
  scopeId: string | null;
  conversationId: string | null;
  mode: ComposerOwner["status"]["mode"];
  connected: boolean;
  metadataPending: boolean;
  draft: string;
  turn: ComposerTurn | null;
  pendingAcceptance: boolean;
  error: string | null;
  maxBytes?: number;
  actions: { setDraft(text: string): void; send(text: string): unknown; cancel(): unknown };
}
export interface ComposerSuggestion { id: string; label: string; text: string }

/** Consume the existing provider result. Never mount a second provider or socket. */
export function bindConversationComposer(owner: ComposerOwner, source: ComposerBinding["source"]): ComposerBinding {
  const id = owner.state.activeId;
  const chat = id && owner.state.order.includes(id) ? owner.state.conversations[id] : undefined;
  const pending = owner.status.pendingSends.find(turn => turn.conversationId === id);
  const turn = Object.values(chat?.turns ?? {}).find(turn => turn.conversationId === id && (turn.state === "queued" || turn.state === "running")) ?? pending ?? null;
  const available = () => {
    if (owner.status.mode !== "scoped" || !owner.state.workspaceId || !id || !chat) throw Error("Conversation unavailable");
    return id;
  };
  return { source, scopeId: owner.state.workspaceId, conversationId: chat ? id : null, mode: owner.status.mode,
    connected: owner.status.connected, metadataPending: owner.status.pending > 0, draft: chat?.draft ?? "",
    turn, pendingAcceptance: !!pending, error: chat?.error ?? null, maxBytes: 65_536,
    actions: {
      setDraft: text => owner.client.store.setDraft(available(), text),
      send: text => owner.client.send(available(), text),
      cancel: () => {
        available();
        if (!turn || turn.conversationId !== id) throw Error("No selected turn");
        // Clear a prior local error so an identical asynchronous retry failure
        // is observable. This is the existing F-04 local error-dismissal action.
        owner.client.store.dismissError(id);
        // Captured identity, never a later conversation's current turn.
        return owner.client.cancel({ conversationId: turn.conversationId, turnId: turn.turnId, requestId: turn.requestId });
      },
    } };
}

export function composerAvailability(mode: "live" | "preview", binding?: ComposerBinding) {
  if (!binding || binding.source !== (mode === "live" ? "live" : "fixture")) return "disabled";
  if (binding.mode !== "scoped") return binding.mode;
  if (!binding.scopeId) return "unavailable";
  return binding.conversationId ? "ready" : "empty";
}
export function draftError(text: string, maxBytes?: number) {
  return maxBytes !== undefined && new TextEncoder().encode(text).length > maxBytes
    ? "This message is too long. Shorten it before sending." : null;
}
export function prefillSuggestion(draft: string, text: string) {
  return draft.trim() ? `${draft}\n${text}` : text;
}
