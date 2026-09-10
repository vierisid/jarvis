import React from "react";
import { useBilling } from "./useBilling";
import { bannerFor, boldSegments } from "./billing-view";
import "./billing.css";

/* Top-of-app billing banner, live. Speaks for past-due, a scheduled cancel and
   an incomplete first payment; active is quiet, and so is everything that is
   not a hosted install with a readable bill. Mounts in the shell's .rs-main
   slot beside the system banners.

   The action is a real target=_blank LINK, not a scripted window.open: a popup
   blocker in an ordinary browser lets a clicked link through, and the sidecar's
   panel hands target=_blank to the system browser, where the change is made on
   the user's own session. */

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
  const { state, summary, links } = useBilling();
  if (state !== "ready" || !summary || !links) return null;
  const banner = bannerFor(summary, Date.now());
  if (!banner) return null;
  const Icon = ICON[banner.icon];
  return (
    <div className={`bl-bnr ${banner.tone}`} role="status">
      <span className="bi"><Icon /></span>
      <span className="bm">
        {boldSegments(banner.message).map((s, i) => (s.bold ? <strong key={i}>{s.text}</strong> : <React.Fragment key={i}>{s.text}</React.Fragment>))}
      </span>
      <span className="ba">
        <a className="bl-btn bl-btn--pri" href={links[banner.action.link]} target="_blank" rel="noopener noreferrer">
          {banner.action.label}
        </a>
      </span>
    </div>
  );
}
