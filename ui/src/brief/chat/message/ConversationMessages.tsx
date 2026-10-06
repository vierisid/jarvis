import React, { useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { ActivityList } from "../activity-renderers/ActivityList";
import { ReplyMarkdown } from "./ReplyMarkdown";
import { running, threadItems, type MessageBinding } from "./model";
import { useReadingPosition, type ThreadMemory } from "./reading";
import { useBriefReducedMotion } from "../../motion";
import "./messages.css";

export function ConversationMessages({ mode, binding, panelId, labelledBy, reducedMotion = false }: {
  mode: "preview" | "live"; binding?: MessageBinding; panelId: string; labelledBy?: string; reducedMotion?: boolean;
}) {
  // Workspace key retires view preferences at the authentication boundary.
  const valid = binding?.source === (mode === "preview" ? "fixture" : "live");
  if (!valid || binding.mode !== "scoped" || !binding.scopeId) return <div className="brief-message-unavailable" role="status">
    {valid && binding.mode === "loading" ? "Loading conversation…" : "Conversation history is unavailable."}</div>;
  return <WorkspaceMessages key={binding.scopeId} binding={binding} panelId={panelId} labelledBy={labelledBy} reducedMotion={reducedMotion}/>;
}
function WorkspaceMessages(props: { binding: MessageBinding; panelId: string; labelledBy?: string; reducedMotion: boolean }) {
  const memory = useRef(new Map<string, ThreadMemory>());
  const { binding } = props, id = binding.conversationId;
  if (!id || !binding.chat) return <div className="brief-message-unavailable">Open a chat to get started.</div>;
  if (!memory.current.has(id)) memory.current.set(id, { reading: { ...binding.chat.scroll }, expanded: {} });
  return <Thread key={id} {...props} memory={memory.current.get(id)!}/>;
}
function Thread({ binding, panelId, labelledBy, reducedMotion, memory }: {
  binding: MessageBinding; panelId: string; labelledBy?: string; reducedMotion: boolean; memory: ThreadMemory;
}) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const [version, setVersion] = useState(0), [historyFailed, setHistoryFailed] = useState(false), [loading, setLoading] = useState(false);
  const generation = useRef(0);
  React.useEffect(() => () => { generation.current++; }, []);
  const reduced = useBriefReducedMotion(reducedMotion);
  const items = threadItems(binding);
  const history = binding.chat!.history;
  const historyReady = history.state !== "idle" && (items.length > 0 || history.state === "ready");
  const scroll = useReadingPosition(viewport, content, memory, binding.saveScroll, items, historyReady);
  const loadOlder = async () => {
    if (loading || !binding.loadOlder) return;
    const mine = generation.current; setLoading(true); setHistoryFailed(false);
    try { await binding.loadOlder(); } catch { if (mine === generation.current) setHistoryFailed(true); }
    finally { if (mine === generation.current) setLoading(false); }
  };
  return <section className="brief-messages" id={panelId} role="tabpanel" aria-labelledby={labelledBy} data-conversation-id={binding.conversationId} data-view-version={version}>
    <div ref={viewport} className="brief-message-scroll" tabIndex={0} role="region" aria-label="Conversation messages" onScroll={scroll.onScroll}>
      <div ref={content} className="brief-message-content">
        {history.cursor && binding.loadOlder && <button type="button" className="brief-history-button" disabled={loading || history.state === "loading"} onClick={loadOlder}>{loading || history.state === "loading" ? "Loading earlier messages…" : "Load earlier messages"}</button>}
        {(historyFailed || history.state === "error") && <p className="brief-message-notice" role="status">{items.length ? "Earlier messages could not be loaded. Your current messages are still here." : "Conversation history could not be loaded."}</p>}
        {!items.length && history.state !== "error" && <h2 className="brief-type-section-heading brief-message-empty">{history.state === "idle" || history.state === "loading" ? "Loading conversation…" : "What are we moving forward?"}</h2>}
        {items.map(item => {
          if (item.kind === "user") return <article key={item.key} data-thread-item={item.key} className="brief-user-message" aria-label="Your message"><p data-reading-anchor="user">{item.message.content}</p></article>;
          const { turn, activities, message } = item;
          const expanded = memory.expanded[item.key] ?? running(turn);
          const failed = turn?.state === "failed", cancelled = turn?.state === "cancelled";
          return <article key={item.key} data-thread-item={item.key} className="brief-assistant-reply" aria-label="Jarvis response" data-running={running(turn)}>
            {activities.length > 0 && <ActivityList activities={activities} turn={turn} expanded={expanded} connected={binding.connected} reduced={reduced}
              toggle={() => { scroll.beforeToggle(viewport.current?.querySelector<HTMLElement>(`[data-thread-item="${CSS.escape(item.key)}"] .brief-activity-toggle`) ?? undefined); memory.expanded[item.key] = !expanded; setVersion(v => v + 1); }}/> }
            {!activities.length && running(turn) && <p className="brief-message-notice" role="status">{binding.connected ? "Preparing your response…" : "Reconnecting…"}</p>}
            {message?.content && <ReplyMarkdown text={message.content}/>}
            {(failed || cancelled) && <p className="brief-message-notice" data-error={failed} data-reading-anchor="terminal" role="status">
              {failed ? "This response could not finish." : "Response stopped."}{message?.content ? " The partial answer is kept above." : ""}</p>}
            {turn?.state === "completed" && !message?.content && <p className="brief-message-notice" data-reading-anchor="terminal">Finished without a text reply.</p>}
          </article>;
        })}
      </div>
    </div>
    {!scroll.following && items.length > 0 && <button className="brief-reply-latest" type="button" onClick={scroll.toLatest}><ArrowDown size={14} aria-hidden="true"/>Latest messages</button>}
  </section>;
}
