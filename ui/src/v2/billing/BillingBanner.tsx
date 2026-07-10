import React from "react";
import { useBillingState, STATE_META, renderBold, BILLING_ENABLED } from "./useBillingState";
import "./billing.css";

/* Top-of-app billing banner. Shows for trial / past-due / canceling / expired
   (active is quiet). Mounts in the shell's .rs-main slot beside the system
   banners. The action walks the lifecycle (demo transitions until a real
   billing backend drives the state). */

const Clock = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Alert = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5 14.5 13.5h-13z" /><path d="M8 6.6v3" /><circle cx="8" cy="11.5" r="0.35" fill="currentColor" stroke="none" /></svg>
);
const Info = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6" /><path d="M8 7.4v3.2" strokeLinecap="round" /><circle cx="8" cy="5.1" r="0.4" fill="currentColor" stroke="none" /></svg>
);
const ICON = { clock: Clock, alert: Alert, info: Info } as const;

export function BillingBanner() {
  const { state, setState } = useBillingState();
  if (!BILLING_ENABLED) return null; // hosted billing not live yet
  const banner = STATE_META[state].banner;
  if (!banner) return null;
  const Icon = ICON[banner.icon];
  return (
    <div className={`bl-bnr ${banner.tone}`} role="status">
      <span className="bi"><Icon /></span>
      <span className="bm">{renderBold(banner.message)}</span>
      <span className="ba">
        <button className="bl-btn bl-btn--pri" onClick={() => setState(banner.action.to)}>{banner.action.label}</button>
      </span>
    </div>
  );
}
