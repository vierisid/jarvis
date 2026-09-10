import React from "react";

/* ═══════════════════ Billing state vocabulary · Monochrome Lab ═══════════════════
   The subscription lifecycle as the design names it (usejarvis-billing-states):
   five states, five tones, and their copy. Used ONLY by the #/_billing design
   gallery (pages/BillingShowcase.tsx), which previews every state with sample
   figures. The live surfaces (Settings → Billing and the shell banner) derive
   their state from the real summary instead: see billing-view.ts + useBilling.ts. */

export type BillingState = "trialing" | "active" | "past_due" | "canceled" | "expired";
export type BillingTone = "info" | "ok" | "warn" | "neutral" | "danger";

export type BannerAction = { label: string; to: BillingState };
export type StateInfo = {
  chip: { tone: BillingTone; label: string };
  /** Top-of-app banner. Null for `active` — nothing needs you. */
  banner: { tone: BillingTone; icon: "clock" | "alert" | "info"; message: string; action: BannerAction } | null;
  planName: string;
  price: string;
  meta: string;
};

// Sample figures for the gallery. `**bold**` markers are rendered by renderBold().
export const STATE_META: Record<BillingState, StateInfo> = {
  trialing: {
    chip: { tone: "info", label: "Trial" },
    banner: { tone: "info", icon: "clock", message: "**11 days left in your trial** of Hosted + AI. Add a card to keep it after.", action: { label: "Add card", to: "active" } },
    planName: "Hosted + AI", price: "$0 now", meta: "Trial ends Jul 26 · then $29/mo · no charge yet",
  },
  active: {
    chip: { tone: "ok", label: "Active" },
    banner: null,
    planName: "Hosted + AI", price: "$29 / mo", meta: "Renews Jul 15, 2026 · Visa •••• 4242",
  },
  past_due: {
    chip: { tone: "warn", label: "Past due" },
    banner: { tone: "warn", icon: "alert", message: "**We couldn't charge your card** on Jul 15. Update it to keep Jarvis running; we'll retry Jul 18.", action: { label: "Update card", to: "active" } },
    planName: "Hosted + AI", price: "$29 / mo", meta: "Payment failed · your brain stays online until Jul 22",
  },
  canceled: {
    chip: { tone: "neutral", label: "Canceling" },
    banner: { tone: "neutral", icon: "info", message: "Your subscription is **canceled**. You have access until Jul 15.", action: { label: "Resume", to: "active" } },
    planName: "Hosted + AI", price: "$29 / mo", meta: "Ends Jul 15, 2026 · then you drop to no hosted brain",
  },
  expired: {
    chip: { tone: "danger", label: "Expired" },
    banner: { tone: "danger", icon: "alert", message: "Your subscription **ended**. Your hosted brain is offline.", action: { label: "Resubscribe", to: "active" } },
    planName: "No active plan", price: "", meta: "Your data is safe. Resubscribe to bring Jarvis back, or self-host.",
  },
};

/** Split `**bold**` copy into React nodes. */
export function renderBold(text: string): React.ReactNode[] {
  return text.split("**").map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <React.Fragment key={i}>{part}</React.Fragment>,
  );
}
