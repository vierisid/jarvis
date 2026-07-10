import React, { useState } from "react";
import { CreditCard } from "lucide-react";
import { STATE_META, renderBold, type BillingState } from "../billing/useBillingState";
import "../billing/billing.css";
import "./BillingShowcase.css";

/**
 * Billing-states gallery. The plan card in all five states, the four banners,
 * and the change-plan modal, framed in both themes. Route: #/_billing. No
 * billing backend is wired (the design's candor) — this previews the state
 * vocabulary; the live surfaces are Settings → Billing + the shell banner.
 */

const STATES: BillingState[] = ["trialing", "active", "past_due", "canceled", "expired"];

const CardActions: Record<BillingState, React.ReactNode> = {
  trialing: (<><button className="bl-btn bl-btn--pri">Add payment method</button><button className="bl-btn">Compare plans</button></>),
  active: (<><button className="bl-btn">Change plan</button><button className="bl-btn bl-btn--red">Cancel</button></>),
  past_due: (<><button className="bl-btn bl-btn--pri">Update card</button><button className="bl-btn">Retry now</button></>),
  canceled: (<button className="bl-btn bl-btn--pri">Resume subscription</button>),
  expired: (<><button className="bl-btn bl-btn--pri">Resubscribe</button><button className="bl-btn">Self-host guide</button></>),
};

const Clock = () => (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>);
const Alert = () => (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5 14.5 13.5h-13z" /><path d="M8 6.6v3" /><circle cx="8" cy="11.5" r="0.35" fill="currentColor" stroke="none" /></svg>);
const Info = () => (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6" /><path d="M8 7.4v3.2" strokeLinecap="round" /><circle cx="8" cy="5.1" r="0.4" fill="currentColor" stroke="none" /></svg>);
const ICON = { clock: Clock, alert: Alert, info: Info } as const;

function PlanCard({ state }: { state: BillingState }) {
  const info = STATE_META[state];
  return (
    <div>
      <div className="bl-plan">
        <div className="bl-plan__head">
          <span className="bl-plan__name">{info.planName}</span>
          <span className={`bl-chip ${info.chip.tone}`}><span className="d" />{info.chip.label}</span>
          {info.price && <span className="bl-plan__price">{info.price}</span>}
        </div>
        <div className="bl-plan__meta">{info.meta}</div>
        <div className="bl-plan__act">{CardActions[state]}</div>
      </div>
      {state === "active" && <div className="bl-allgood"><span className="dot" />All good. Nothing needs you.</div>}
      <div className="blx-lab">{state.replace("_", " ")}</div>
    </div>
  );
}

function Banner({ state }: { state: BillingState }) {
  const banner = STATE_META[state].banner;
  if (!banner) return null;
  const Icon = ICON[banner.icon];
  return (
    <div className="blx-bnrframe">
      <div className={`bl-bnr ${banner.tone}`}>
        <span className="bi"><Icon /></span>
        <span className="bm">{renderBold(banner.message)}</span>
        <span className="ba"><button className="bl-btn bl-btn--pri">{banner.action.label}</button></span>
      </div>
    </div>
  );
}

export function BillingShowcase(): React.ReactElement {
  const [theme, setTheme] = useState<string>(() => (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme")) || "light");
  const flip = (t: string) => { document.documentElement.setAttribute("data-theme", t); setTheme(t); };
  const [choice, setChoice] = useState<"up" | "down">("up");
  const PRORATE = {
    up: "You'll be charged **€33.20 today**, prorated for the 10 days left this cycle. Then **€79/mo** from Jul 15.",
    down: "No charge today. Your plan changes to **Hosted** at renewal on Jul 15, and you keep everything until then. After that, **€9.99/mo**.",
  };

  return (
    <div className="blx">
      <header className="blx-head">
        <div>
          <h1>Billing states</h1>
          <p>The subscription lifecycle: the Settings → Billing plan card by state, the top-of-app banner, and the change-plan modal. Tone tells the truth before the words do.</p>
        </div>
        <div className="blx-seg" role="group" aria-label="Theme">
          <button className={theme !== "dark" ? "on" : ""} onClick={() => flip("light")}>Light</button>
          <button className={theme === "dark" ? "on" : ""} onClick={() => flip("dark")}>Dark</button>
        </div>
      </header>

      <div className="blx-sec">Today · Settings → Billing (billing not enabled)</div>
      <div className="blx-soonframe">
        <div className="bl-soon">
          <div className="bl-soon__mark"><CreditCard size={22} strokeWidth={1.6} /></div>
          <div className="bl-soon__title">Billing is coming soon</div>
          <div className="bl-soon__sub">Hosted plans and subscriptions will live here. For now Jarvis runs on your own model keys or self-hosted, at no charge.</div>
          <span className="bl-chip info"><span className="d" />Coming soon</span>
        </div>
      </div>

      <div className="blx-sec">Plan card · when billing ships</div>
      <div className="blx-grid">{STATES.map((s) => <PlanCard key={s} state={s} />)}</div>

      <div className="blx-sec">State banner · top of app</div>
      <div className="blx-banners">{STATES.map((s) => <Banner key={s} state={s} />)}</div>

      <div className="blx-sec">Change plan · modal</div>
      <div className="blx-modalframe">
        <div className="bl-modal__box" style={{ position: "static", transform: "none" }}>
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
            <button className="bl-btn">Cancel</button>
            <button className="bl-btn bl-btn--pri">{choice === "up" ? "Switch to Max" : "Schedule downgrade"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
