import React, { useRef, useState } from "react";
import { TodaySpecimen } from "../../../today/preview/TodaySpecimen";
import { ConversationTabStrip } from "../../tab-strip/ConversationTabStrip";
import { bindConversationTabs, chatTabId } from "../../tab-strip/model";
import { ConversationComposer } from "../../composer/ConversationComposer";
import { bindConversationComposer } from "../../composer/model";
import { AttachmentFan } from "../../attachment-fan/AttachmentFan";
import { ConversationMessages } from "../ConversationMessages";
import { bindConversationMessages, running, type MessageChat, type Activity, type ReadingPosition } from "../model";

const answer = "## Aim for a clear next step.\n\nAgree the pilot scope, success criteria and a date you can both commit to.\n\n**Three questions to settle**\n\n1. What would make this pilot a win?\n2. Who needs to sign off?\n3. What can we commit to this week?\n\nFinish with an owner and a next date.";
const longAnswer = answer + Array.from({ length: 16 }, (_, i) => `\n\n### Decision ${i + 1}\n\nKeep one accountable owner for this step. Agree the success measure before choosing a date, and preserve anything still awaiting confirmation. Paragraph ${i + 1} stays in place while new activity arrives.`).join("")
  + '\n\n```typescript\nconst workflow = { name: "Meeting follow-ups", approval: "required", enabled: false };\n```\n\n| Step | Status |\n| --- | --- |\n| Draft | Ready |\n| Send | Awaiting review |\n\n[Jarvis website](https://www.usejarvis.dev)';
interface Chat extends MessageChat { conversation: { title: string }; draft: string; error: string | null }
function example(id: string, title: string): Chat {
  const turnId = `${id}-1`, requestId = `${id}-request-1`;
  const refs = [{ kind: "goal", id: "design-partners" }, { kind: "fact", id: "pilot" }];
  return { conversation: { title }, draft: "", error: null, scroll: { top: 0, atBottom: false }, history: { state: "ready", cursor: "older" },
    messages: [{ id: `${id}-user`, conversation_id: id, role: "user", content: id === "general" ? "Prepare my next call with Alex." : "Summarize this week’s progress.", created_at: 1 },
      { id: `${id}-answer`, conversation_id: id, role: "assistant", content: id === "general" ? answer : "## Two new design partners.\n\nSix out of ten signed. The next step is to confirm the remaining pilots.", created_at: 2 }],
    turns: { [turnId]: { conversationId: id, turnId, requestId, createdAt: 1, state: "completed", assistantMessageId: `${id}-answer` } },
    activity: Object.fromEntries(["Context lookup finished.", "Context lookup finished.", "File read finished."].map((summary, i) => [`${id}-activity-${i}`, {
      activityId: `${id}-activity-${i}`, conversationId: id, turnId, requestId, firstSequence: i + 1, sequence: i + 4, live: false,
      kind: "tool", phase: "completed", summary, refs: refs[i] ? [refs[i]!] : [],
    } satisfies Activity])) };
}

/** Explicit fixture events, not inferred reasoning. Production uses F-06's existing owner. */
export function MessageSpecimen() {
  const [chats, setChats] = useState<Record<string, Chat>>(() => ({ general: example("general", "General"), investor: example("investor", "Investor update") }));
  const [order, setOrder] = useState(["general", "investor"]), [activeId, setActive] = useState<string | null>("general");
  const [connected, setConnected] = useState(true), [mode, setMode] = useState<"scoped" | "unavailable">("scoped");
  const serial = useRef(1);
  const update = (id: string, patch: Partial<Chat>) => setChats(previous => ({ ...previous, [id]: { ...previous[id]!, ...patch } }));
  const start = (id: string, text: string) => {
    const chat = chats[id]!, n = ++serial.current, turnId = `${id}-turn-${n}`, requestId = `${id}-request-${n}`, time = Date.now();
    update(id, { draft: "", messages: [...chat.messages, { id: `${turnId}-user`, conversation_id: id, role: "user", content: text, created_at: time }],
      turns: { ...chat.turns, [turnId]: { conversationId: id, turnId, requestId, state: "running", createdAt: time, assistantMessageId: `${turnId}-answer` } },
      activity: { ...chat.activity, [turnId]: { activityId: turnId, conversationId: id, turnId, requestId, firstSequence: n * 10, sequence: n * 10, live: true,
        kind: "tool", phase: "started", summary: "Looking up saved context.", refs: [{ kind: "fact", id: "pilot" }] } } });
  };
  const current = activeId ? chats[activeId] : undefined;
  const turn = Object.values(current?.turns ?? {}).sort((a,b) => b.createdAt - a.createdAt)[0];
  const finish = (state: "completed" | "failed" | "cancelled", long = false) => {
    if (!activeId || !current || !turn) return;
    update(activeId, { turns: { ...current.turns, [turn.turnId]: { ...turn, state } },
      activity: Object.fromEntries(Object.entries(current.activity ?? {}).map(([id, a]) => [id, a.turnId === turn.turnId && a.phase === "started"
        ? { ...a, phase: state === "completed" ? "completed" : "failed", summary: state === "completed" ? "Context lookup finished." : "Context lookup could not finish.", live: false } : a])),
      messages: [...current.messages.filter(m => m.id !== turn.assistantMessageId), { id: turn.assistantMessageId!, conversation_id: activeId, role: "assistant", content: long ? longAnswer : state === "completed" ? answer : "## The pilot scope is ready.\n\nThe remaining context could not be retrieved.", created_at: turn.createdAt + 1 }] });
  };
  const owner = { status: { mode, connected, pending: 0, pendingSends: [], error: null, progressEnabled: true },
    state: { workspaceId: "message-preview", order, activeId, conversations: chats },
    client: {
      store: { setDraft: (id: string, draft: string) => update(id, { draft }), setError: (id: string, error: string | null) => update(id, { error }),
        setScroll: (id: string, scroll: ReadingPosition) => setChats(previous => ({ ...previous, [id]: { ...previous[id]!, scroll } })) },
      add: async () => { const id = `chat-${++serial.current}`; setChats(previous => ({ ...previous, [id]: { ...example(id, "New chat"), messages: [], turns: {}, activity: {}, scroll: { top: 0, atBottom: true }, history: { state: "ready", cursor: null } } })); setOrder(previous => [...previous, id]); setActive(id); },
      select: async (id: string) => setActive(id), close: async (id: string) => { const i = order.indexOf(id); if (activeId === id) setActive(order[i + 1] ?? order[i - 1] ?? null); setOrder(previous => previous.filter(x => x !== id)); },
      send: async (id: string, text: string) => start(id, text), cancel: () => finish("cancelled"),
      loadOlder: async (id: string) => setChats(previous => ({ ...previous, [id]: { ...previous[id]!, history: { state: "ready", cursor: null }, messages: [
        { id: `${id}-older`, conversation_id: id, role: "user", content: "Keep the next pilot small and measurable.", created_at: 0 }, ...previous[id]!.messages] } })),
    } };
  return <TodaySpecimen reviewTitle="D-15 · Activity and finished replies" reviewTools={<>
    <button disabled={!activeId || running(turn)} onClick={() => activeId && start(activeId, "Prepare my next call with Alex.")}>Start response</button>
    <button disabled={!turn} onClick={() => finish("completed")}>Finish response</button>
    <button disabled={!turn} onClick={() => finish("failed")}>Partial failure</button>
    <button disabled={!turn} onClick={() => finish("completed", true)}>Long reply</button>
    <button disabled={!activeId} onClick={() => activeId && current && update(activeId, { activity: Object.fromEntries(Object.entries(current.activity ?? {}).map(([id,a]) => [id, { ...a, live: false }])) })}>Replay snapshot</button>
    <label><input type="checkbox" checked={connected} onChange={e => setConnected(e.target.checked)}/>Connected</label>
    <label><input type="checkbox" checked={mode === "unavailable"} onChange={e => setMode(e.target.checked ? "unavailable" : "scoped")}/>Unavailable</label>
  </>} conversation={reduced => <>
    <ConversationTabStrip mode="preview" binding={bindConversationTabs(owner, "fixture")} panelId="d15-conversation" reducedMotion={reduced}/>
    <ConversationMessages mode="preview" binding={bindConversationMessages(owner, "fixture")} panelId="d15-conversation" labelledBy={activeId ? chatTabId("d15-conversation", activeId) : undefined} reducedMotion={reduced}/>
    <ConversationComposer mode="preview" binding={bindConversationComposer(owner, "fixture")} reducedMotion={reduced}
      suggestions={[{ id: "call", label: "Prepare a call", text: "Prepare my next call with Alex." }, { id: "workflow", label: "Review a workflow", text: "Review my meeting follow-up workflow." }]}
      attachmentControl={<AttachmentFan mode="preview" reducedMotion={reduced} binding={{ source: "fixture", scopeId: "message-preview", conversationId: activeId, enabled: connected && !!activeId,
        screenshot: { available: false, reason: "No capture-capable desktop connected." }, choose: async () => "cancelled" }} onFeedback={() => {}}/>}/>
  </>}/>;
}
