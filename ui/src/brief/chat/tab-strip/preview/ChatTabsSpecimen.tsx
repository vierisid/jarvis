import React, { useLayoutEffect, useRef, useState } from "react";
import { TodaySpecimen } from "../../../today/preview/TodaySpecimen";
import { ConversationTabStrip } from "../ConversationTabStrip";
import { bindConversationTabs, chatTabId, type ConversationTabsOwner } from "../model";
import "./specimen.css";

interface ExampleChat { conversation: { title: string }; draft: string; answer: string; top: number }
const seed = (): Record<string, ExampleChat> => ({
  general: { conversation: { title: "General" }, draft: "", answer: "What are we moving forward?", top: 0 },
  investor: { conversation: { title: "Investor update · September milestones and the next six design partners" }, draft: "Summarize this week’s progress.", answer: "Two new design partners this week.", top: 0 },
});
/** Deliberately isolated data owner. F-04, not this fixture, supplies production history/policy. */
export function ChatTabsSpecimen() {
  const [chats, setChats] = useState(seed), [order, setOrder] = useState(["general", "investor"]);
  const [activeId, setActive] = useState<string | null>("general");
  const [mode, setMode] = useState<ConversationTabsOwner["status"]["mode"]>("scoped");
  const [failure, setFailure] = useState(false), [pending, setPending] = useState(0), [long, setLong] = useState(false);
  const [closed, setClosed] = useState<string | null>(null);
  const counter = useRef(0);
  const operate = async (commit: () => void) => {
    setPending(1); await new Promise(resolve => setTimeout(resolve, 100));
    setPending(0); if (failure) throw new Error("Illustrative metadata error"); commit();
  };
  const owner: ConversationTabsOwner = { status: { mode, pending, error: null }, state: { workspaceId: "fixture-workspace", order, activeId, conversations: chats }, client: {
    add: () => operate(() => {
      const id = `chat-${++counter.current}`;
      setChats(previous => ({ ...previous, [id]: { conversation: { title: `New chat ${counter.current}` }, draft: "", answer: "What are we moving forward?", top: 0 } }));
      setOrder(previous => [...previous, id]); setActive(id);
    }),
    select: id => operate(() => setActive(id)),
    close: id => operate(() => {
      // Fixture follows inspected F-04 policy: right, then left, then null. Never delete content.
      const index = order.indexOf(id);
      if (activeId === id) setActive(order[index + 1] ?? order[index - 1] ?? null);
      setOrder(previous => previous.filter(item => item !== id)); setClosed(id);
    }),
  } };
  const update = (id: string, patch: Partial<ExampleChat>) => setChats(previous => ({ ...previous, [id]: { ...previous[id]!, ...patch } }));
  return <TodaySpecimen reviewTools={<>
    <label>Chat mode <select aria-label="Chat mode" value={mode} onChange={event => setMode(event.target.value as typeof mode)}>{["scoped", "loading", "legacy", "unavailable", "disabled"].map(value => <option key={value}>{value}</option>)}</select></label>
    <label><input type="checkbox" checked={failure} onChange={event => setFailure(event.target.checked)}/> Fail tab writes</label>
    <label><input type="checkbox" checked={long} onChange={event => setLong(event.target.checked)}/> Long retained reply</label>
    <button disabled={!closed || pending > 0} onClick={() => { if (closed) { setOrder(previous => previous.includes(closed) ? previous : [...previous, closed]); setActive(closed); setClosed(null); } }}>Reopen last closed fixture</button>
  </>} conversation={reduced => <ExampleConversation binding={bindConversationTabs(owner, "fixture")} activeId={activeId} chats={chats} update={update} long={long} reduced={reduced}/>} />;
}

function ExampleConversation({ binding, activeId, chats, update, long, reduced }: {
  binding: ReturnType<typeof bindConversationTabs>; activeId: string | null; chats: Record<string, ExampleChat>;
  update: (id: string, patch: Partial<ExampleChat>) => void; long: boolean; reduced: boolean;
}) {
  const thread = useRef<HTMLDivElement>(null), active = activeId ? chats[activeId] : null;
  const scoped = binding.status.mode === "scoped", panelId = "d12-conversation";
  useLayoutEffect(() => { if (thread.current) thread.current.scrollTop = active?.top ?? 0; }, [activeId, scoped]);
  return <>
    <ConversationTabStrip mode="preview" binding={binding} panelId={panelId} reducedMotion={reduced}/>
    <div className="d12-example-panel" id={panelId} role={scoped && active ? "tabpanel" : undefined}
      aria-labelledby={scoped && activeId ? chatTabId(panelId, activeId) : undefined} data-active-chat={activeId ?? ""}>
      {scoped ? active && activeId ? <>
        <div ref={thread} className="sample-conversation-thread" tabIndex={0} aria-label="Conversation messages"
          onScroll={event => update(activeId, { top: event.currentTarget.scrollTop })}>
          <h2 className="brief-type-section-heading">{active.answer}</h2>
          {long && Array.from({ length: 12 }, (_, index) => <p key={index}>Illustrative retained paragraph {index + 1} · {active.conversation.title}</p>)}
        </div>
        <label className="d12-example-label" htmlFor="d12-draft">Draft · {active.conversation.title}</label>
        <textarea id="d12-draft" className="sample-conversation-input" data-pebble-focus aria-label="Conversation draft"
          value={active.draft} onChange={event => update(activeId, { draft: event.target.value })} placeholder="Ask Jarvis…" rows={2}/>
      </> : <p>No conversation open. Use + to start one.</p>
      : <p>{binding.status.mode === "legacy" ? "Single-chat owner content belongs here. This fixture does not connect to a live chat." : "The owner has not provided a ready conversation."}</p>}
    </div>
  </>;
}
