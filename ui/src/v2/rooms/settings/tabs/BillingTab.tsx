import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CreditCard } from "lucide-react";
import type { SettingsHook } from "../useSettingsData";
import { confirmDialog } from "../../../ui/ConfirmDialog";
import { useBillingState, STATE_META, renderBold, BILLING_ENABLED, type BillingState } from "../../../billing/useBillingState";
import "../../../billing/billing.css";

/* Settings → Billing. The plan card carries the subscription state; the
   change-plan modal shows the prorated math before you commit. No processor is
   wired (the design's candor note), so state changes are local demo
   transitions until a billing backend drives them. No dark patterns: cancel is
   reversible, downgrades keep paid access, invoices say what's real. */

type Toast = (text: string, tone?: "ok" | "warn") => void;

const PRORATE = {
  up: "You'll be charged **€33.20 today**, prorated for the 10 days left this cycle. Then **€79/mo** from Jul 15.",
  down: "No charge today. Your plan changes to **Hosted** at renewal on Jul 15, and you keep everything until then. After that, **€9.99/mo**.",
};
const CONFIRM = { up: "Switch to Max", down: "Schedule downgrade" };

function ChangePlanModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (choice: "up" | "down") => void }) {
  const [choice, setChoice] = useState<"up" | "down">("up");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="bl-modal" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bl-modal__box" role="dialog" aria-modal="true" aria-label="Change your plan">
        <div className="bl-modal__head">
          <div className="bl-modal__title">Change your plan</div>
          <div className="bl-modal__sub">You're on Hosted + AI · €29/mo</div>
        </div>
        <div className="bl-opts" role="radiogroup" aria-label="Plan">
          <button type="button" role="radio" aria-checked={choice === "up"} className="bl-opt" onClick={() => setChoice("up")}>
            <span className="rad" /><span className="ot"><span className="otn">Hosted + AI · Max</span><span className="otd">5× the tokens, highest priority</span></span><span className="op">€79</span>
          </button>
          <button type="button" role="radio" aria-checked={choice === "down"} className="bl-opt" onClick={() => setChoice("down")}>
            <span className="rad" /><span className="ot"><span className="otn">Hosted</span><span className="otd">Bring your own model keys</span></span><span className="op">€9.99</span>
          </button>
        </div>
        <div className="bl-prorate">{renderBold(PRORATE[choice])}</div>
        <div className="bl-modal__foot">
          <button className="bl-btn" onClick={onClose}>Cancel</button>
          <button className="bl-btn bl-btn--pri" onClick={() => onConfirm(choice)}>{CONFIRM[choice]}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function BillingTab({ onToast }: { data: SettingsHook; onToast: Toast }) {
  const { state, setState } = useBillingState();
  const [modal, setModal] = useState(false);

  // Hosted billing isn't live yet — show a coming-soon state rather than a
  // plan card that would look like a real subscription (the design's candor).
  if (!BILLING_ENABLED) {
    return (
      <div className="bl-soon">
        <div className="bl-soon__mark"><CreditCard size={22} strokeWidth={1.6} /></div>
        <div className="bl-soon__title">Billing is coming soon</div>
        <div className="bl-soon__sub">Hosted plans and subscriptions will live here. For now Jarvis runs on your own model keys or self-hosted, at no charge.</div>
        <span className="bl-chip info"><span className="d" />Coming soon</span>
      </div>
    );
  }

  const info = STATE_META[state];

  const cancel = async () => {
    if (await confirmDialog(
      "Cancel your subscription?\n\nYou keep full access until the end of the current period, and you can resume any time before then.",
      { confirmLabel: "Cancel subscription" },
    )) {
      setState("canceled");
      onToast("Subscription set to cancel at period end.", "ok");
    }
  };
  const go = (to: BillingState, msg: string) => () => { setState(to); onToast(msg, "ok"); };

  const actions = (() => {
    switch (state) {
      case "trialing":
        return (<><button className="bl-btn bl-btn--pri" onClick={go("active", "Payment method added — trial converted.")}>Add payment method</button><button className="bl-btn" onClick={() => setModal(true)}>Compare plans</button></>);
      case "active":
        return (<><button className="bl-btn" onClick={() => setModal(true)}>Change plan</button><button className="bl-btn bl-btn--red" onClick={cancel}>Cancel</button></>);
      case "past_due":
        return (<><button className="bl-btn bl-btn--pri" onClick={go("active", "Card updated — payment retried.")}>Update card</button><button className="bl-btn" onClick={go("active", "Retry succeeded.")}>Retry now</button></>);
      case "canceled":
        return (<button className="bl-btn bl-btn--pri" onClick={go("active", "Subscription resumed.")}>Resume subscription</button>);
      case "expired":
        return (<><button className="bl-btn bl-btn--pri" onClick={go("active", "Resubscribed — your brain is back.")}>Resubscribe</button><button className="bl-btn" onClick={() => window.open("https://usejarvis.com/docs/self-hosting", "_blank", "noopener")}>Self-host guide</button></>);
    }
  })();

  const showRecords = state === "active" || state === "past_due" || state === "trialing";
  const invoiceToast = () => onToast("Invoice download needs the billing backend.", "warn");

  return (
    <div>
      <div className="bl-sublabel" style={{ marginTop: 4 }}>Plan</div>
      <div className="bl-plan">
        <div className="bl-plan__head">
          <span className="bl-plan__name">{info.planName}</span>
          <span className={`bl-chip ${info.chip.tone}`}><span className="d" />{info.chip.label}</span>
          {info.price && <span className="bl-plan__price">{info.price}</span>}
        </div>
        <div className="bl-plan__meta">{info.meta}</div>
        <div className="bl-plan__act">{actions}</div>
      </div>
      {state === "active" && <div className="bl-allgood"><span className="dot" />All good. Nothing needs you.</div>}

      {showRecords && (
        <>
          <div className="bl-sublabel">Payment method</div>
          <div className="bl-receipt">
            <div className="bl-receipt__row"><span>Card</span><span className="v">Visa •••• 4242</span></div>
            <div className="bl-receipt__row"><span>Expires</span><span className="v">08 / 27</span></div>
          </div>
          <div className="bl-sublabel">Billing history</div>
          <div className="bl-receipt">
            <div className="bl-receipt__row"><span>Jun 15, 2026 · Hosted + AI</span><span className="v">€29.00 <button className="link" onClick={invoiceToast}>Invoice</button></span></div>
            <div className="bl-receipt__row"><span>May 15, 2026 · Hosted + AI</span><span className="v">€29.00 <button className="link" onClick={invoiceToast}>Invoice</button></span></div>
          </div>
        </>
      )}

      {modal && (
        <ChangePlanModal
          onClose={() => setModal(false)}
          onConfirm={(c) => { setModal(false); onToast(c === "up" ? "Switched to Max." : "Downgrade scheduled for renewal.", "ok"); }}
        />
      )}
    </div>
  );
}
