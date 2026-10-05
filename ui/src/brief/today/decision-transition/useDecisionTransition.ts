import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBriefReducedMotion } from "../../motion";
import { canAct, type DecisionAction, type DecisionBinding, type DecisionPaper } from "../hero-paper/model";
import { DECISION_TIMING, hasNextProjection, reconcileDecision, type DecisionTransition } from "./controller";

export function useDecisionTransition(binding: DecisionBinding, forceReduced: boolean) {
  const reduced = useBriefReducedMotion(forceReduced);
  const [transition, setTransition] = useState<DecisionTransition | null>(null);
  const [arriving, setArriving] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const attempt = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useLayoutEffect(() => {
    if (!transition) return;
    // A denied capability binding deliberately contains no writer or data. Do not keep
    // showing its old document merely because an operation used to be in flight.
    if (!binding.onAction && binding.state.status === "unavailable") {
      setTransition(null); setArriving(false); lock.current = false; attempt.current = null; return;
    }
    const next = reconcileDecision(transition, binding);
    if (next !== transition) { setTransition(next); return; }
    if (transition.phase === "awaiting" && hasNextProjection(transition, binding)) {
      setTransition(null); setArriving(!reduced && binding.state.status === "ready");
      lock.current = !reduced && binding.state.status === "ready";
      attempt.current = null;
    }
  }, [binding, transition, reduced]);

  useEffect(() => {
    if (!transition || !["confirmed", "settling"].includes(transition.phase)) return;
    const phase = transition.phase;
    const delay = phase === "confirmed" ? DECISION_TIMING.confirmation : reduced ? 0 : DECISION_TIMING.settlement;
    const timer = setTimeout(() => setTransition(current => current === transition
      ? { ...current, phase: phase === "confirmed" ? "settling" : "awaiting" } : current), delay);
    return () => clearTimeout(timer);
  }, [transition, reduced]);
  useEffect(() => {
    if (!arriving) return;
    const timer = setTimeout(() => { setArriving(false); lock.current = false; }, reduced ? 0 : DECISION_TIMING.arrival);
    return () => clearTimeout(timer);
  }, [arriving, reduced]);

  const act = useCallback((paper: DecisionPaper, action: DecisionAction) => {
    if (lock.current || !canAct(binding, paper, action)) return;
    lock.current = true;
    // getRandomValues also works for self-hosted HTTP origins where randomUUID is absent.
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    attempt.current = requestId;
    setTransition({ paper, action, requestId, phase: "pending", message: "Waiting for confirmation…", tone: "attention" });
    const failed = () => {
      if (!mounted.current || attempt.current !== requestId) return;
      setTransition(current => current?.requestId === requestId && current.phase === "pending"
        ? { ...current, phase: "blocked", tone: "attention", message: "The response was lost. Refresh to check the outcome before trying again." } : current);
    };
    try { void Promise.resolve(binding.onAction?.(paper.decision, action, requestId)).catch(failed); } catch { failed(); }
  }, [binding]);

  // A deliberate refresh can supply a new reviewed version of the same decision after
  // conflict. Unknown effects stay blocked unless the owner reconciles this exact attempt.
  useLayoutEffect(() => {
    if (transition?.phase === "blocked" && binding.operation?.state === "conflict"
      && binding.operation.requestId === transition.requestId && binding.state.status === "ready"
      && binding.state.data.decision.decisionId === transition.paper.decision.decisionId
      && binding.state.data.decision.revision !== transition.paper.decision.revision) {
      setTransition(null); lock.current = false; attempt.current = null;
    }
  }, [binding, transition]);

  return { transition, arriving, act, reduced };
}
