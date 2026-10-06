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
  const live = useRef({ key, active: false });
  const lock = useRef<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [settledReceipt, setSettledReceipt] = useState<string | null>(null);
  const [cue, setCue] = useState<{ key: string; title: string; workItemId: string } | null>(null);
  const shown = useRef<string | null>(null);
  const [expiryTick, tick] = useState(0);
  const reduced = useBriefReducedMotion(reducedMotion);
  useLayoutEffect(() => {
    live.current = { key, active: true }; lock.current = null; setAttempt(null); setCue(null); setSettledReceipt(null); shown.current = null;
    return () => { live.current.active = false; };
  }, [key]);
  useEffect(() => {
    if (!rec || rec.state !== "available" || !Number.isFinite(rec.expiresAt)) return;
    const remaining = rec.expiresAt - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => tick(n => n + 1), Math.min(remaining + 1, 2147483647));
    return () => clearTimeout(timer);
  }, [rec?.expiresAt, rec?.state, expiryTick]);
  const current = attempt?.key === key ? attempt : null;
  const destination = current?.result ? queuedDestination(current.result, current.title, binding.queue) : null;
  const receiptId = current?.result?.state === "confirmed" ? current.result.receiptId : null;
  const related = rec?.goalId === goal?.goalId && rec?.goalRevision === goal?.revision;
  const accepted = (!!destination || (!!receiptId && settledReceipt === receiptId)) && binding.state.status === "ready" && binding.recommendation.status === "ready" && related;
  useEffect(() => { if (accepted && receiptId) setSettledReceipt(receiptId); }, [accepted, receiptId]);
  useEffect(() => {
    if (!accepted || !destination || !receiptId || shown.current === receiptId) return;
    // Local acknowledgement first, followed by the coordinated destination cue.
    const timer = setTimeout(() => { shown.current = receiptId; setCue({ key, title: destination!.title, workItemId: destination!.workItemId }); }, reduced ? 0 : 160);
    return () => clearTimeout(timer);
  }, [accepted, receiptId, key, reduced]);
  useEffect(() => {
    if (!cue) return;
    const timer = setTimeout(() => setCue(null), reduced ? 1200 : 1800);
    return () => clearTimeout(timer);
  }, [cue, reduced]);
  const blocked = recommendationBlock(binding, Date.now());
  const accept = () => {
    if (lock.current === key || current || recommendationBlock(binding, Date.now()) || !rec || !goal || !binding.onAccept) return;
    lock.current = key;
    const request = { requestId: crypto.randomUUID(), recommendationId: rec.recommendationId, revision: rec.revision, goalId: goal.goalId, goalRevision: goal.revision };
    const started: Attempt = { key, request, title: rec.title };
    setAttempt(started);
    // Promise resolution alone is never a receipt, and no optimistic queue/progress write occurs.
    Promise.resolve().then(() => binding.onAccept!(request)).then(result => {
      if (!live.current.active || live.current.key !== key) return;
      const valid = matchingReceipt(request, result) && (result.state !== "confirmed" || !!result.receiptId && !!result.destination?.decisionId && !!result.destination.workItemId && result.destination.title === started.title);
      setAttempt(valid ? { ...started, result } : { ...started, unknown: true });
    }).catch(() => {
      if (live.current.active && live.current.key === key) setAttempt({ ...started, unknown: true });
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
