import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBriefReducedMotion } from "../../motion";
import { goalView, matchingReceipt, queuedDestination, recommendationBlock, type GoalAcceptRequest, type GoalAcceptResult, type GoalCardBinding } from "./model";

type Attempt = { key: string; request: GoalAcceptRequest; title: string; result?: GoalAcceptResult; unknown?: boolean };
/** Local feedback only. Receipt persistence, idempotency, expiry and queue writes remain with F-13. */
export function useGoalHandoff(mode: "live" | "preview", input?: GoalCardBinding, reducedMotion = false) {
  const binding = goalView(mode, input);
  const goal = "data" in binding.state ? binding.state.data : null;
  const rec = "data" in binding.recommendation ? binding.recommendation.data : null;
  const key = JSON.stringify([mode, binding.source, goal?.goalId, goal?.revision, rec?.recommendationId, rec?.revision]);
  const lifecycle = useRef(0);
  // A missing read is not a new recommendation. Retain each attempted identity until
  // this owner scope unmounts, so reconnecting cannot unlock an unresolved request.
  const requests = useRef(new Map<string, Attempt>());
  const [attempts, setAttempts] = useState<ReadonlyMap<string, Attempt>>(new Map());
  const [settledReceipts, setSettledReceipts] = useState<ReadonlySet<string>>(new Set());
  const [cue, setCue] = useState<{ key: string; title: string; workItemId: string } | null>(null);
  const shown = useRef(new Set<string>());
  const [expiryTick, tick] = useState(0);
  const reduced = useBriefReducedMotion(reducedMotion);
  useLayoutEffect(() => {
    lifecycle.current++;
    requests.current.clear(); setAttempts(new Map()); setCue(null); setSettledReceipts(new Set()); shown.current.clear();
    return () => { lifecycle.current++; requests.current.clear(); };
  }, [mode, binding.source]);
  useEffect(() => { setCue(null); }, [key]);
  useEffect(() => {
    if (!rec || rec.state !== "available" || !Number.isFinite(rec.expiresAt)) return;
    const remaining = rec.expiresAt - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => tick(n => n + 1), Math.min(remaining + 1, 2147483647));
    return () => clearTimeout(timer);
  }, [rec?.expiresAt, rec?.state, expiryTick]);
  const current = attempts.get(key);
  const destination = current?.result ? queuedDestination(current.result, current.title, binding.queue) : null;
  const receiptId = current?.result?.state === "confirmed" ? current.result.receiptId : null;
  const related = rec?.goalId === goal?.goalId && rec?.goalRevision === goal?.revision;
  const accepted = (!!destination || (!!receiptId && settledReceipts.has(receiptId))) && binding.state.status === "ready" && binding.recommendation.status === "ready" && related;
  useEffect(() => {
    if (accepted && receiptId) setSettledReceipts(previous => previous.has(receiptId) ? previous : new Set(previous).add(receiptId));
  }, [accepted, receiptId]);
  useEffect(() => {
    if (!accepted || !destination || !receiptId || shown.current.has(receiptId)) return;
    // Local acknowledgement first, followed by the coordinated destination cue.
    const timer = setTimeout(() => { shown.current.add(receiptId); setCue({ key, title: destination!.title, workItemId: destination!.workItemId }); }, reduced ? 0 : 160);
    return () => clearTimeout(timer);
  }, [accepted, receiptId, key, reduced]);
  useEffect(() => {
    if (!cue) return;
    const timer = setTimeout(() => setCue(null), reduced ? 1200 : 1800);
    return () => clearTimeout(timer);
  }, [cue, reduced]);
  const blocked = recommendationBlock(binding, Date.now());
  const accept = () => {
    if (requests.current.has(key) || recommendationBlock(binding, Date.now()) || !rec || !goal || !binding.onAccept) return;
    const request = { requestId: crypto.randomUUID(), recommendationId: rec.recommendationId, revision: rec.revision, goalId: goal.goalId, goalRevision: goal.revision };
    const started: Attempt = { key, request, title: rec.title };
    const epoch = lifecycle.current;
    const record = (value: Attempt) => { requests.current.set(key, value); setAttempts(new Map(requests.current)); };
    const isCurrentRequest = () => lifecycle.current === epoch && requests.current.get(key)?.request.requestId === request.requestId;
    record(started);
    // Promise resolution alone is never a receipt, and no optimistic queue/progress write occurs.
    Promise.resolve().then(() => binding.onAccept!(request)).then(result => {
      if (!isCurrentRequest()) return;
      const valid = matchingReceipt(request, result) && (result.state !== "confirmed" || !!result.receiptId && !!result.destination?.decisionId && !!result.destination.workItemId && result.destination.title === started.title);
      record(valid ? { ...started, result } : { ...started, unknown: true });
    }).catch(() => {
      if (isCurrentRequest()) record({ ...started, unknown: true });
    });
  };
  const pending = !!current && !current.result && !current.unknown;
  const historical = rec?.state === "accepted" && related;
  const message = accepted || historical ? "Added to Today" : current?.unknown || current?.result?.state === "unknown" ? "Addition is not confirmed. Refresh before trying again."
    : current?.result?.state === "conflict" ? "This recommendation changed. Refresh before adding it."
      : current?.result?.state === "failed" ? "The step was not added. Refresh to check the current recommendation."
        : current?.result?.state === "confirmed" ? "Accepted. Waiting for the refreshed Today stack."
          : pending ? "Adding to Today…" : blocked;
  return { binding, goal, rec, key, pending, accepted: accepted || historical, locked: !!current || !!blocked, message, accept, reduced,
    cue: cue?.key === key && accepted ? cue : null };
}
export type GoalHandoff = ReturnType<typeof useGoalHandoff>;
