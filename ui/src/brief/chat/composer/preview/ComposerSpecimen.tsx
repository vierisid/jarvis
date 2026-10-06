import React, { useEffect, useRef, useState } from "react";
import { TodaySpecimen } from "../../../today/preview/TodaySpecimen";
import { ConversationTabStrip } from "../../tab-strip/ConversationTabStrip";
import { bindConversationTabs, chatTabId } from "../../tab-strip/model";
import { ConversationComposer } from "../ConversationComposer";
import { bindConversationComposer, type ComposerOwner, type ComposerTurn } from "../model";
import "./specimen.css";

interface Chat { conversation: { title: string }; draft: string; error: string | null; turns: Record<string, ComposerTurn & { state: string }>; sent: string[]; answer: string }
const seed = (): Record<string, Chat> => ({
  general: { conversation: { title: "General" }, draft: "", error: null, turns: {}, sent: [], answer: "" },
  investor: { conversation: { title: "Investor update" }, draft: "Summarize this week’s progress.", error: null, turns: {}, sent: [], answer: "" },
});
const suggestions = [
  { id: "call", label: "Prepare a call", text: "Prepare my next call with Alex." },
  { id: "workflow", label: "Review a workflow", text: "Review my meeting follow-up workflow." },
];

/** UI-only owner with explicit acknowledgments. Production consumes F-04 instead. */
export function ComposerSpecimen() {
  const [chats, setChats] = useState(seed), [order, setOrder] = useState(["general", "investor"]);
  const [activeId, setActive] = useState<string | null>("general"), [pendingSends, setPendingSends] = useState<ComposerTurn[]>([]);
  const [connected, setConnected] = useState(true), [failure, setFailure] = useState(false), [hold, setHold] = useState(false), [failStop, setFailStop] = useState(false);
  const [mode, setMode] = useState<ComposerOwner["status"]["mode"]>("scoped");
  const [sendCount, setSendCount] = useState(0), [cancelCount, setCancelCount] = useState(0);
  const serial = useRef(0), turns = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const finish = (ref: ComposerTurn, state: "completed" | "cancelled") => {
    if (!alive.current) return;
    setChats(previous => {
      const chat = previous[ref.conversationId], turn = chat?.turns[ref.turnId];
      if (!chat || !turn || turn.state !== "running") return previous;
      return { ...previous, [ref.conversationId]: { ...chat, turns: { ...chat.turns, [ref.turnId]: { ...turn, state } },
        answer: state === "completed" ? "Aim for a clear next step. Agree the pilot scope, success criteria and a date you can both commit to." : "Response stopped." } };
    });
  };
  const owner = {
    status: { mode, connected, pending: 0, pendingSends, error: null },
    state: { workspaceId: "composer-preview", order, activeId, conversations: chats },
    client: {
      store: { setDraft: (id: string, text: string) => setChats(previous => ({ ...previous, [id]: { ...previous[id]!, draft: text } })) },
      add: async () => {
        const id = `chat-${++serial.current}`;
        setChats(previous => ({ ...previous, [id]: { conversation: { title: `New chat ${serial.current}` }, draft: "", error: null, turns: {}, sent: [], answer: "" } }));
        setOrder(previous => [...previous, id]); setActive(id);
      },
      select: async (id: string) => setActive(id),
      close: async (id: string) => {
        const index = order.indexOf(id);
        if (activeId === id) setActive(order[index + 1] ?? order[index - 1] ?? null);
        setOrder(previous => previous.filter(item => item !== id));
      },
      send: async (id: string, text: string) => {
        if (!connected) throw Error("Offline fixture");
        const ref = { conversationId: id, turnId: `turn-${++turns.current}`, requestId: `request-${turns.current}` };
        setSendCount(count => count + 1); setPendingSends(previous => [...previous, ref]);
        await new Promise(resolve => setTimeout(resolve, 300));
        if (!alive.current) return;
        setPendingSends(previous => previous.filter(item => item.requestId !== ref.requestId));
        if (failure) throw Error("Illustrative send failure");
        setChats(previous => ({ ...previous, [id]: { ...previous[id]!, draft: previous[id]!.draft === text ? "" : previous[id]!.draft,
          sent: [...previous[id]!.sent, text], answer: "", turns: { ...previous[id]!.turns, [ref.turnId]: { ...ref, state: "running" } } } }));
        if (!hold) setTimeout(() => finish(ref, "completed"), 1500);
      },
      cancel: async (ref: ComposerTurn) => {
        setCancelCount(count => count + 1); await new Promise(resolve => setTimeout(resolve, 200));
        if (!alive.current) return;
        if (failStop) throw Error("Illustrative cancellation failure");
        finish(ref, "cancelled");
      },
    },
  };
  const composer = bindConversationComposer(owner, "fixture");
  const current = activeId ? chats[activeId] : null;
  return <TodaySpecimen reviewTitle="D-13 · Compact writing and send pebble" reviewTools={<>
    <label>Chat mode <select aria-label="Chat mode" value={mode} onChange={event => setMode(event.target.value as typeof mode)}>{["scoped", "loading", "legacy", "unavailable", "disabled"].map(value => <option key={value}>{value}</option>)}</select></label>
    <label><input type="checkbox" checked={connected} onChange={event => setConnected(event.target.checked)} /> Connected</label>
    <label><input type="checkbox" checked={failure} onChange={event => setFailure(event.target.checked)} /> Fail send</label>
    <label><input type="checkbox" checked={hold} onChange={event => setHold(event.target.checked)} /> Hold response</label>
    <label><input type="checkbox" checked={failStop} onChange={event => setFailStop(event.target.checked)} /> Fail stop</label>
    <button disabled={!composer.turn} onClick={() => { if (composer.turn) finish(composer.turn, "completed"); }}>Finish response</button>
    <output aria-label="Fixture operations">{sendCount} sends · {cancelCount} stops</output>
  </>} conversation={reduced => <>
    <ConversationTabStrip mode="preview" binding={bindConversationTabs(owner, "fixture")} panelId="d13-conversation" reducedMotion={reduced} />
    <section id="d13-conversation" className="d13-thread" role={current ? "tabpanel" : undefined}
      aria-labelledby={activeId ? chatTabId("d13-conversation", activeId) : undefined} data-active-chat={activeId ?? ""}>
      {current?.sent.map((text, index) => <p key={index} className="d13-user-message">{text}</p>)}
      {current?.answer ? <p className="d13-example-answer">{current.answer}</p> : composer.turn ? <p className="d13-example-progress">Preparing your response…</p>
        : <h2 className="brief-type-section-heading">What are we moving forward?</h2>}
    </section>
    <ConversationComposer mode="preview" binding={composer} suggestions={suggestions} reducedMotion={reduced} />
  </>} />;
}
