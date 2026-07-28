import React, { useEffect, useState } from "react";

/* ═══════════════════ Billing state · Monochrome Lab ═══════════════════
   The subscription lifecycle from usejarvis-billing-states.html. Five
   states, five tones. No payment processor is wired in code yet (the design's
   own candor note), so this is the state vocabulary + copy for a billing
   backend to drive. Until then it's localStorage-backed so the lifecycle is
   walkable in the shell (Settings → Billing) and previewable for QA. Live
   across the banner + the tab via a same-tab custom event. */

/** Hosted billing / subscriptions aren't live yet (no processor wired). Until
 *  then the Settings → Billing tab shows a "coming soon" state and the shell
 *  banner is suppressed. Flip to true when the billing backend ships; the plan
 *  card, banners, change-plan modal, and #/_billing gallery are all ready. */
export const BILLING_ENABLED = false;

export type BillingState = "trialing" | "active" | "past_due" | "canceled" | "expired";
export type BillingTone = "info" | "ok" | "warn" | "neutral" | "danger";

export type PlanKey = "hosted" | "hosted_ai" | "max";
export const PLANS: Record<PlanKey, { name: string; price: string; blurb: string }> = {
  hosted: { name: "Hosted", price: "€9.99", blurb: "Bring your own model keys" },
  hosted_ai: { name: "Hosted + AI", price: "€29", blurb: "Managed models, nothing to configure" },
  max: { name: "Hosted + AI · Max", price: "€79", blurb: "5× the tokens, highest priority" },
};

/** The plan a returning user is on. Static until the billing backend is wired. */
export const CURRENT_PLAN: PlanKey = "hosted_ai";

export type BannerAction = { label: string; to: BillingState };
export type StateInfo = {
  chip: { tone: BillingTone; label: string };
  /** Top-of-app banner. Null for `active` — nothing needs you. */
  banner: { tone: BillingTone; icon: "clock" | "alert" | "info"; message: string; action: BannerAction } | null;
  planName: string;
  price: string;
  meta: string;
};

// `**bold**` markers in copy are rendered by renderBold() below.
export const STATE_META: Record<BillingState, StateInfo> = {
  trialing: {
    chip: { tone: "info", label: "Trial" },
    banner: { tone: "info", icon: "clock", message: "**11 days left in your trial** of Hosted + AI. Add a card to keep it after.", action: { label: "Add card", to: "active" } },
    planName: "Hosted + AI", price: "€0 now", meta: "Trial ends Jul 26 · then €29/mo · no charge yet",
  },
  active: {
    chip: { tone: "ok", label: "Active" },
    banner: null,
    planName: "Hosted + AI", price: "€29 / mo", meta: "Renews Jul 15, 2026 · Visa •••• 4242",
  },
  past_due: {
    chip: { tone: "warn", label: "Past due" },
    banner: { tone: "warn", icon: "alert", message: "**We couldn't charge your card** on Jul 15. Update it to keep Jarvis running; we'll retry Jul 18.", action: { label: "Update card", to: "active" } },
    planName: "Hosted + AI", price: "€29 / mo", meta: "Payment failed · your brain stays online until Jul 22",
  },
  canceled: {
    chip: { tone: "neutral", label: "Canceling" },
    banner: { tone: "neutral", icon: "info", message: "Your subscription is **canceled**. You have access until Jul 15.", action: { label: "Resume", to: "active" } },
    planName: "Hosted + AI", price: "€29 / mo", meta: "Ends Jul 15, 2026 · then you drop to no hosted brain",
  },
  expired: {
    chip: { tone: "danger", label: "Expired" },
    banner: { tone: "danger", icon: "alert", message: "Your subscription **ended**. Your hosted brain is offline.", action: { label: "Resubscribe", to: "active" } },
    planName: "No active plan", price: "", meta: "Your data is safe. Resubscribe to bring Jarvis back, or self-host.",
  },
};

const KEY = "jarvis-billing-state";
const EVT = "jarvis:billing-state";

function readState(): BillingState {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "trialing" || v === "active" || v === "past_due" || v === "canceled" || v === "expired") return v;
  } catch { /* no storage */ }
  return "active";
}

export function useBillingState(): { state: BillingState; setState: (s: BillingState) => void } {
  const [state, setLocal] = useState<BillingState>(readState);
  useEffect(() => {
    const reRead = () => setLocal(readState());
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) reRead(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVT, reRead);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVT, reRead);
    };
  }, []);
  const setState = (s: BillingState) => {
    try { localStorage.setItem(KEY, s); } catch { /* no storage */ }
    setLocal(s);
    window.dispatchEvent(new Event(EVT)); // update the banner + tab live in this tab
  };
  return { state, setState };
}

/** Split `**bold**` copy into React nodes. */
export function renderBold(text: string): React.ReactNode[] {
  return text.split("**").map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <React.Fragment key={i}>{part}</React.Fragment>,
  );
}
