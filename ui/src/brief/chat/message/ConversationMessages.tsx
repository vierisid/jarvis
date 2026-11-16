import React, { useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { ActivityList } from "../activity-renderers/ActivityList";
import { ApprovalCard } from "../../../v2/thread/ApprovalCard";
import { ReplyMarkdown } from "./ReplyMarkdown";
import { running, threadItems, type MessageBinding } from "./model";
import { useReadingPosition, type ThreadMemory } from "./reading";
import { useBriefReducedMotion } from "../../motion";
import { DESTINATIONS, targetHref } from "../../navigation/destinations";
// The .brief-sr-only helper on the approval waiting line (#1092).
import "../../components/controls/controls.css";
import "./messages.css";

const providerFailureCodes = new Set([
  'provider_background_throttled', 'provider_auth', 'provider_forbidden', 'provider_rate_limit',
  'provider_network', 'provider_bad_request', 'provider_unsupported_tools', 'provider_not_found',
  'provider_server', 'provider_quota_exhausted', 'provider_content_policy', 'provider_restricted',
  'provider_plan_inactive',
]);
// Where the person fixes each failure (src/brief/chat-failure.ts). Credentials
// and models are AI settings. Hosted usage and plans are Usage and Billing:
// the managed Usejarvis AI row in AI settings is read-only. A restriction is
// appealed to the contact its message names and a content policy block is
// changed in the request, so neither links anywhere.
export const failureLinks: Record<string, { label: string; target: (typeof DESTINATIONS)[keyof typeof DESTINATIONS]["legacy"] }> = {
  provider_auth: { label: "Open AI settings", target: DESTINATIONS.credentials.legacy },
  provider_forbidden: { label: "Open AI settings", target: DESTINATIONS.credentials.legacy },
  provider_rate_limit: { label: "Open AI settings", target: DESTINATIONS.credentials.legacy },
  provider_not_found: { label: "Open AI settings", target: DESTINATIONS.credentials.legacy },
  provider_unsupported_tools: { label: "Open AI settings", target: DESTINATIONS.credentials.legacy },
  provider_quota_exhausted: { label: "Open usage", target: DESTINATIONS.usage.legacy },
  provider_plan_inactive: { label: "Open billing", target: DESTINATIONS.billing.legacy },
};
// The daemon's other turn failures, each with copy it wrote itself (src/brief/chat-transport.ts,
// src/brief/chat-failure.ts, src/vault/chat-turns.ts): never an upstream body.
const authoredFailureCodes = new Set(['generation_failed', 'attachment_unavailable', 'interrupted']);
// Only classified codes carry authored recovery copy. A code this client does
// not know may carry raw detail and keeps the safe fallback.
function failureNotice(error?: { code?: string; message?: string }) {
  return error?.code && (providerFailureCodes.has(error.code) || authoredFailureCodes.has(error.code)) && error.message
    ? error.message : 'This response could not finish.';
}

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
  // Why a decision did not go through, by approval id: the card stays and says so. The dashboard
  // notes only a refused approve; here a refused cancel or an unreachable daemon is said too.
  const [approvalNotes, setApprovalNotes] = useState<Record<string, string>>({});
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
  // The same routes and decider as the dashboard card (#1075). A fixture never decides.
  const decide = binding.source !== "live" ? undefined : async (approvalId: string, decision: "approve" | "deny") => {
    const mine = generation.current;
    let note: string | undefined;
    try {
      const response = await fetch(`/api/authority/approvals/${encodeURIComponent(approvalId)}/${decision}`, { method: "POST" });
      if (!response.ok) note = ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `${decision === "approve" ? "Approve" : "Cancel"} failed: ${response.status}`;
    } catch { note = "Jarvis could not be reached. Try again."; }
    if (mine !== generation.current) return;
    setApprovalNotes(prev => {
      if (note) return { ...prev, [approvalId]: note };
      if (!(approvalId in prev)) return prev;
      const { [approvalId]: _cleared, ...rest } = prev; return rest;
    });
  };
  return <section className="brief-messages" id={panelId} role="tabpanel" aria-labelledby={labelledBy} data-conversation-id={binding.conversationId} data-view-version={version}>
    <div ref={viewport} className="brief-message-scroll" tabIndex={0} role="region" aria-label="Conversation messages" onScroll={scroll.onScroll}>
      <div ref={content} className="brief-message-content">
        {history.cursor && binding.loadOlder && <button type="button" className="brief-history-button" disabled={loading || history.state === "loading"} onClick={loadOlder}>{loading || history.state === "loading" ? "Loading earlier messages…" : "Load earlier messages"}</button>}
        {(historyFailed || history.state === "error") && <p className="brief-message-notice">{items.length ? "Earlier messages could not be loaded. Your current messages are still here." : "Conversation history could not be loaded."}</p>}
        {!items.length && history.state !== "error" && <h2 className="brief-type-section-heading brief-message-empty">{history.state === "idle" || history.state === "loading" ? "Loading conversation…" : "What are we moving forward?"}</h2>}
        {items.map(item => {
          if (item.kind === "user") return <article key={item.key} data-thread-item={item.key} className="brief-user-message" aria-label="Your message"><p data-reading-anchor="user">{item.message.content}</p></article>;
          const { turn, activities, message } = item;
          const expanded = memory.expanded[item.key] ?? running(turn);
          const failed = turn?.state === "failed", cancelled = turn?.state === "cancelled";
          return <article key={item.key} data-thread-item={item.key} className="brief-assistant-reply" aria-label="Jarvis response" data-running={running(turn)}>
            {activities.length > 0 && <ActivityList activities={activities} turn={turn} expanded={expanded} connected={binding.connected} reduced={reduced}
              toggle={() => { scroll.beforeToggle(viewport.current?.querySelector<HTMLElement>(`[data-thread-item="${CSS.escape(item.key)}"] .brief-activity-toggle`) ?? undefined); memory.expanded[item.key] = !expanded; setVersion(v => v + 1); }}/> }
            {/* Say why the turn waits instead of "working", then the existing dashboard card for it (#1075). */}
            {/* The cards are regions, not dialogs (#1092): this line names the action, and liveNotice says the
                same in the thread's one status region, which changes in place when another one arrives or a
                card's details land (#1162). The card below already shows the action, so the naming part is for
                screen readers only. */}
            {item.awaitingApproval && <p className="brief-message-notice" data-reading-anchor="approval">Waiting for your approval before continuing.{" "}
              <span className="brief-sr-only">{waitingDetail(item.pendingApprovalIds, binding.approvalCards)}</span></p>}
            {item.pendingApprovalIds.map(approvalId => {
              const card = binding.approvalCards?.[approvalId];
              return card ? <div key={approvalId} className="brief-message-approval" data-approval-id={approvalId}>
                <ApprovalCard intent={card.intent} reason={card.intentReason} category={card.category} impact={card.impact} note={approvalNotes[approvalId]}
                  onApprove={decide && (() => void decide(approvalId, "approve"))} onCancel={decide && (() => void decide(approvalId, "deny"))}/>
              </div> : null;
            })}
            {!activities.length && running(turn) && !item.awaitingApproval && <div className="brief-response-working" data-reduced={reduced}>
            <span className="brief-activity-marker" data-current={binding.connected} aria-hidden="true"/>
            <span>{binding.connected ? (turn?.state === "queued" ? "Waiting to respond…" : "Preparing your response…") : "Reconnecting…"}</span>
          </div>}
            {message?.content && <ReplyMarkdown text={message.content}/>}
            {(failed || cancelled) && <p className="brief-message-notice" data-error={failed} data-reading-anchor="terminal">
              {failed ? failureNotice(turn.error) : "Response stopped."}{message?.content ? " The partial answer is kept above." : ""}</p>}
            {failed && Object.hasOwn(failureLinks, turn.error?.code ?? '') &&
              <a data-failure-link href={targetHref(window.location.href, failureLinks[turn.error!.code!]!.target)}>{failureLinks[turn.error!.code!]!.label}</a>}
            {turn?.state === "completed" && !message?.content && <p className="brief-message-notice" data-reading-anchor="terminal">Finished without a text reply.</p>}
          </article>;
        })}
      </div>
    </div>
    {/* One persistent live region (#1162): a status region inserted together with its text is
        announced unreliably, so the notices above are plain text and this one changes in place. */}
    <p className="brief-sr-only" role="status">{liveNotice(items, binding, historyFailed || history.state === "error")}</p>
    {!scroll.following && items.length > 0 && <button className="brief-reply-latest" type="button" onClick={scroll.toLatest}><ArrowDown size={14} aria-hidden="true"/>Latest messages</button>}
  </section>;
}

/** What the region says now: the latest reply's state, else a history failure. */
function liveNotice(items: ReturnType<typeof threadItems>, binding: MessageBinding, historyFailed: boolean): string {
  const latest = [...items].reverse().find(item => item.kind !== "user");
  if (latest?.kind === "reply") {
    const turn = latest.turn;
    if (latest.awaitingApproval) return `Waiting for your approval before continuing. ${waitingDetail(latest.pendingApprovalIds, binding.approvalCards)}`.trim();
    if (turn?.state === "failed") return `${failureNotice(turn.error)}${latest.message?.content ? " The partial answer is kept above." : ""}`;
    if (turn?.state === "cancelled") return `Response stopped.${latest.message?.content ? " The partial answer is kept above." : ""}`;
    if (running(turn) && !latest.activities.length)
      return binding.connected ? (turn?.state === "queued" ? "Waiting to respond…" : "Preparing your response…") : "Reconnecting…";
  }
  if (historyFailed) return items.length ? "Earlier messages could not be loaded. Your current messages are still here." : "Conversation history could not be loaded.";
  return "";
}

function waitingDetail(ids: readonly string[], cards: MessageBinding["approvalCards"]): string {
  const shown = ids.flatMap(id => cards?.[id] ? [cards[id]!] : []);
  if (shown.length > 1) return `${shown.length} actions are waiting.`;
  if (shown.length === 1) return `Action: ${shown[0]!.intent}`;
  return "";
}
