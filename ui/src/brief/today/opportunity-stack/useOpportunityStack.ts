import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBriefReducedMotion } from "../../motion";
import { activationBlock, canDismiss, confirmedResult, matchesRequest, opportunityKey, opportunityView, OPPORTUNITY_TIMING, resultMessage, type OpportunityAction, type OpportunityBinding, type OpportunityCard, type OpportunityRequest, type OpportunityResult } from "./model";

interface Attempt { request: OpportunityRequest; successors: readonly string[]; result?: OpportunityResult }
interface Transition {
  key: string; card: OpportunityCard; phase: "pending" | "acknowledged" | "exit" | "enter";
  action?: OpportunityAction; count: number; index: number;
}

export function useOpportunityStack(mode: "live" | "preview", supplied?: OpportunityBinding, forceReduced = false) {
  const binding = opportunityView(mode, supplied);
  const reduced = useBriefReducedMotion(forceReduced);
  const [selected, setSelected] = useState<string | null>(null);
  const [transition, setTransition] = useState<Transition | null>(null);
  const [revision, repaint] = useState(0);
  const attempts = useRef(new Map<string, Attempt>());
  const settled = useRef(new Set<string>());
  const lock = useRef(false);
  const epoch = useRef(0);
  useEffect(() => { const generation = ++epoch.current; return () => { if (epoch.current === generation) epoch.current++; }; }, []);
  const raw = "data" in binding.state ? binding.state.data : [];
  const duplicate = new Set(raw.map(c => c.proposal.proposalId)).size !== raw.length;
  const items = duplicate ? [] : raw.filter(c => !settled.current.has(opportunityKey(binding, c)) && !["accepted", "dismissed"].includes(c.proposal.state));
  const stored = items.find(c => opportunityKey(binding, c) === selected) ?? items[0] ?? null;
  const scope = (card: OpportunityCard) => opportunityKey(binding, card);
  const transitionInScope = transition && scope(transition.card) === transition.key;
  // Do not retain a removed account's content or a superseded revision during a local transition.
  const replaced = transition && raw.some(c => c.proposal.proposalId === transition.card.proposal.proposalId && scope(c) !== transition.key);
  const showing = transitionInScope && !replaced && ["ready", "stale"].includes(binding.state.status) && !duplicate ? transition : null;
  // Browsing cached proposals is local. Action acknowledgements still require fresh data.
  const canTransition = binding.state.status === "ready" || (binding.state.status === "stale" && !transition?.action);
  const card = showing?.card ?? stored;
  const key = card ? scope(card) : null;
  const attempt = key ? attempts.current.get(key) : undefined;
  const count = showing?.count ?? items.length;
  const index = showing?.index ?? (card ? Math.max(0, items.indexOf(card)) : 0);
  const current = useRef({ binding, items, card, key, count, index });
  current.current = { binding, items, card, key, count, index };
  useLayoutEffect(() => {
    if (!transition && stored && opportunityKey(binding, stored) !== selected) setSelected(opportunityKey(binding, stored));
  }, [transition, stored, binding.source, binding.scopeKey, selected]);

  useLayoutEffect(() => {
    if (!transition) return;
    if (!transitionInScope || replaced || duplicate) { lock.current = false; setTransition(null); return; }
    if (transition.phase !== "pending" || binding.state.status !== "ready" || !binding.onAction) return;
    const a = attempts.current.get(transition.key);
    if (!a) return;
    const recovered = binding.receipts?.find(r => confirmedResult(a.request, r));
    if (recovered) a.result = recovered;
    if (!a.result) return;
    if (confirmedResult(a.request, a.result)) setTransition({ ...transition, phase: "acknowledged" });
    else { lock.current = false; setTransition(null); }
  }, [transition, transitionInScope, replaced, duplicate, binding.state.status, binding.onAction, binding.receipts, revision]);

  // A lost response stays locked. A correlated owner receipt may reconcile it later.
  useLayoutEffect(() => {
    if (transition || !key || !card || binding.state.status !== "ready" || !binding.onAction) return;
    const a = attempts.current.get(key);
    if (!a) return;
    const recovered = binding.receipts?.find(r => confirmedResult(a.request, r)) ?? (confirmedResult(a.request, a.result) ? a.result : undefined);
    if (!recovered && a.result) return;
    if (recovered) a.result = recovered;
    lock.current = true;
    setTransition({ key, card, count, index, action: a.request.action, phase: recovered ? "acknowledged" : "pending" });
  }, [transition, key, card, count, index, binding.state.status, binding.onAction, binding.receipts]);

  useEffect(() => {
    if (!transition || !showing || !canTransition || transition.phase === "pending") return;
    const phase = transition.phase;
    const duration = phase === "acknowledged" ? transition.action === "dismiss" ? OPPORTUNITY_TIMING.dismiss : OPPORTUNITY_TIMING.acknowledge
      : reduced ? 0 : phase === "exit" ? OPPORTUNITY_TIMING.exit : OPPORTUNITY_TIMING.enter;
    const timer = setTimeout(() => {
      if (phase === "acknowledged") { setTransition({ ...transition, phase: "exit" }); return; }
      if (phase === "enter") { lock.current = false; setTransition(null); return; }
      const { binding: latest, items: available } = current.current;
      if (transition.action) settled.current.add(transition.key);
      const remaining = available.filter(c => !settled.current.has(opportunityKey(latest, c)));
      const positions = new Map(remaining.map((c, i) => [opportunityKey(latest, c), i]));
      // Keep the reviewed neighbours even if a refresh removes or reorders earlier cards.
      const successor = attempts.current.get(transition.key)?.successors.find(key => positions.has(key));
      const nextIndex = transition.action ? successor ? positions.get(successor)! : 0
        : ((positions.get(transition.key) ?? -1) + 1) % remaining.length;
      const next = remaining[nextIndex];
      setSelected(next ? opportunityKey(latest, next) : null);
      if (!next) { lock.current = false; setTransition(null); repaint(n => n + 1); return; }
      setTransition({ key: opportunityKey(latest, next), card: next, count: remaining.length, index: nextIndex, phase: "enter" });
    }, duration);
    return () => clearTimeout(timer);
  }, [transition, showing, canTransition, reduced]);

  const next = () => {
    const s = current.current;
    if (lock.current || !s.card || !s.key || s.items.length < 2) return;
    lock.current = true;
    setSelected(s.key);
    setTransition({ key: s.key, card: s.card, count: s.items.length, index: s.items.indexOf(s.card), phase: "exit" });
  };
  const act = (action: OpportunityAction) => {
    const s = current.current;
    if (lock.current || !s.card || !s.key || attempts.current.has(s.key) || !s.binding.onAction || (action === "approve_enable" ? activationBlock(s.binding, s.card) !== null : !canDismiss(s.binding, s.card))) return;
    const p = s.card.proposal;
    const request: OpportunityRequest = { requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""), proposalId: p.proposalId, revision: p.revision, action, flowId: p.workflow?.flowId ?? null, versionId: p.workflow?.versionId ?? null };
    // Prefer following cards, then the nearest preceding card when resolving the last one.
    // Store identities on the attempt so read/scope recovery retains the same destination.
    const successors = [...s.items.slice(s.index + 1), ...s.items.slice(0, s.index).reverse()].map(c => opportunityKey(s.binding, c));
    const a: Attempt = { request, successors }; attempts.current.set(s.key, a);
    lock.current = true; setSelected(s.key);
    setTransition({ key: s.key, card: s.card, count: s.count, index: s.index, action, phase: "pending" });
    const generation = epoch.current;
    const finish = (result?: OpportunityResult) => {
      if (epoch.current !== generation || attempts.current.get(s.key!) !== a || confirmedResult(a.request, a.result)) return;
      a.result = matchesRequest(request, result) ? result : { ...request, state: "unknown" };
      repaint(n => n + 1);
    };
    try { void Promise.resolve(s.binding.onAction(request)).then(finish, () => finish()); } catch { finish(); }
  };
  const phase = canTransition ? showing?.phase ?? "rest" : "rest";
  const confirming = !!showing?.action && (phase === "acknowledged" || phase === "exit");
  const message = binding.state.status === "stale" ? "Refresh this proposal before enabling it."
    : confirming ? showing.action === "approve_enable" ? "Workflow enabled" : "Dismissed"
    : attempt ? resultMessage(attempt.result) : card ? activationBlock(binding, card) : null;
  return { binding, card, count, index, phase, reduced, confirming, action: showing?.action, message, next, act,
    duplicate, locked: !!showing || !!attempt, moving: !!showing, canNext: count > 1 && !showing,
    canApprove: !!card && !showing && !attempt && !activationBlock(binding, card),
    canDismiss: !!card && !showing && !attempt && canDismiss(binding, card) };
}
