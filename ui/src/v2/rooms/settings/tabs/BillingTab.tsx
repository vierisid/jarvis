import React, { useState } from "react";
import { CreditCard, ExternalLink, RefreshCw } from "lucide-react";
import type { SettingsHook } from "../useSettingsData";
import { useBilling } from "../../../billing/useBilling";
import {
  billingState,
  boldSegments,
  brandLabel,
  cardExpiresBefore,
  chargedCard,
  endsAt,
  formatDate,
  formatExpiry,
  formatMoney,
  formatPrice,
  isHttpsUrl,
  needsAttention,
  nextChargeDate,
  paymentRow,
  planMeta,
  planTitle,
  recurringTotal,
  STATE_CHIP,
  type BillingLinks,
  type BillingSummary,
} from "../../../billing/billing-view";
import { openExternal, openedOrHandedOff } from "../../../onboarding/external-open";
import "../../../billing/billing.css";

/* Settings -> Billing, live (control plane: docs/BILLING.md "Billing inside the
   brain"). Everything about the bill is shown here; nothing here changes it.
   Every action opens the account billing page in the system browser, where the
   user's own session authorizes it — this brain holds a READ-only credential by
   design, so a compromised assistant can read its owner's bill but never
   cancel it. No dark patterns: cancel is one click away and never hidden. */

type Toast = (text: string, tone?: "ok" | "warn") => void;

const HISTORY_PREVIEW = 12;

function Bold({ text }: { text: string }) {
  return (
    <>
      {boldSegments(text).map((s, i) => (s.bold ? <strong key={i}>{s.text}</strong> : <React.Fragment key={i}>{s.text}</React.Fragment>))}
    </>
  );
}

function Soon({ title, sub, children }: { title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className="bl-soon">
      <div className="bl-soon__mark"><CreditCard size={22} strokeWidth={1.6} /></div>
      <div className="bl-soon__title">{title}</div>
      <div className="bl-soon__sub">{sub}</div>
      {children && <div className="bl-soon__act">{children}</div>}
    </div>
  );
}

export function BillingTab({ onToast }: { data: SettingsHook; onToast: Toast }) {
  const billing = useBilling();
  const [showAll, setShowAll] = useState(false);

  const open = (url: string) => {
    if (!openedOrHandedOff(openExternal(url))) {
      onToast("Couldn't open your browser. Open your usejarvis account's billing page to continue.", "warn");
    }
  };

  if (billing.state === "self") {
    return (
      <Soon
        title="No bill on this Jarvis"
        sub="This Jarvis runs on your own machine with your own model keys, so there is nothing to pay for here. Hosted plans and their billing live with usejarvis."
      />
    );
  }
  if (billing.state === "unknown") {
    return <Soon title="Loading billing…" sub="Reading your plan and payments from your usejarvis account." />;
  }
  if ((billing.state === "unavailable" || !billing.summary) && !billing.links) {
    // No billing connection at all: a hosted install whose control plane did
    // not render one, or a self-hoster fronting this brain over a unix socket
    // (which reads as hosted). Neither is an outage, so say it calmly.
    return (
      <Soon
        title="Billing isn't connected here"
        sub="This Jarvis has no link to a usejarvis billing account. If you're on a hosted plan, you can manage billing from your usejarvis account."
      >
        <button className="bl-btn" onClick={billing.refresh}>Check again</button>
      </Soon>
    );
  }
  if (billing.state === "unavailable" || !billing.summary || !billing.links) {
    return (
      <Soon
        title="Billing is unavailable right now"
        sub="Your plan and payments couldn't be read from your usejarvis account. Reading them here never changes them."
      >
        <button className="bl-btn" onClick={billing.refresh}>Try again</button>
        {billing.links && (
          <button className="bl-btn bl-btn--pri" onClick={() => open(billing.links!.page)}>Open billing in browser</button>
        )}
      </Soon>
    );
  }

  return (
    <Live
      summary={billing.summary}
      links={billing.links}
      stale={billing.stale}
      readAt={billing.readAt}
      onRefresh={billing.refresh}
      open={open}
      showAll={showAll}
      onShowAll={() => setShowAll(true)}
    />
  );
}

function Live({
  summary,
  links,
  stale,
  readAt,
  onRefresh,
  open,
  showAll,
  onShowAll,
}: {
  summary: BillingSummary;
  links: BillingLinks;
  stale: boolean;
  readAt: number;
  onRefresh: () => void;
  open: (url: string) => void;
  showAll: boolean;
  onShowAll: () => void;
}) {
  const now = Date.now();
  const sub = summary.subscription;
  const state = billingState(sub);
  const chip = STATE_CHIP[state];
  const total = recurringTotal(summary.plans);
  const next = summary.upcomingInvoice;
  const nextChargeAt = nextChargeDate(summary);
  const charged = chargedCard(summary);
  const payments = showAll ? summary.payments : summary.payments.slice(0, HISTORY_PREVIEW);

  const actions = (() => {
    switch (state) {
      case "active":
        return (
          <>
            <button className="bl-btn" onClick={() => open(links.changePlan)}>Change plan</button>
            <button className="bl-btn" onClick={() => open(links.paymentMethod)}>Update card</button>
            <button className="bl-btn bl-btn--red" onClick={() => open(links.cancel)}>Cancel</button>
          </>
        );
      case "canceling":
        return (
          <>
            <button className="bl-btn bl-btn--pri" onClick={() => open(links.manage)}>Resume subscription</button>
            <button className="bl-btn" onClick={() => open(links.paymentMethod)}>Update card</button>
          </>
        );
      case "past_due":
        return (
          <>
            <button className="bl-btn bl-btn--pri" onClick={() => open(links.paymentMethod)}>Update card</button>
            <button className="bl-btn" onClick={() => open(links.manage)}>View invoices</button>
          </>
        );
      case "incomplete":
        return <button className="bl-btn bl-btn--pri" onClick={() => open(links.manage)}>Complete payment</button>;
      default:
        return <button className="bl-btn bl-btn--pri" onClick={() => open(links.page)}>Open billing</button>;
    }
  })();

  const periodRows: Array<[string, string]> = [];
  if (sub) {
    const start = formatDate(sub.currentPeriodStart);
    const end = formatDate(sub.currentPeriodEnd);
    if (start && end) periodRows.push(["Current period", `${start} – ${end}`]);
    else if (end) periodRows.push(["Current period ends", end]);
    if (state === "active" && next) {
      const on = formatDate(next.date);
      periodRows.push(["Next charge", `${formatMoney(next.amountDueCents, next.currency)}${on ? ` on ${on}` : ""}`]);
    } else if (state === "active" && end) {
      periodRows.push(["Renews", end]);
    }
    if (state === "canceling") {
      const ends = formatDate(endsAt(sub));
      if (ends) periodRows.push([Date.parse(endsAt(sub)!) > now ? "Ends" : "Ended", ends]);
    }
    if (state === "past_due") {
      const grace = formatDate(sub.graceUntil);
      if (grace && sub.graceUntil && Date.parse(sub.graceUntil) > now) periodRows.push(["Online until", grace]);
    }
    const since = formatDate(sub.startedAt);
    if (since) periodRows.push(["Customer since", since]);
  }

  return (
    <div className="bl-live">
      <div className="bl-sublabel" style={{ marginTop: 4 }}>Plan</div>
      <div className="bl-plan">
        <div className="bl-plan__head">
          <span className="bl-plan__name">{planTitle(summary.plans)}</span>
          <span className={`bl-chip ${chip.tone}`}><span className="d" />{chip.label}</span>
          {total && <span className="bl-plan__price">{formatPrice(total)}</span>}
        </div>
        <div className="bl-plan__meta"><Bold text={planMeta(summary, now)} /></div>
        <div className="bl-plan__act">{actions}</div>
      </div>
      {state === "active" && !stale && !needsAttention(summary) && (
        <div className="bl-allgood"><span className="dot" />All good. Nothing needs you.</div>
      )}

      {summary.plans.length > 0 && (
        <>
          <div className="bl-sublabel">What's included</div>
          <div className="bl-receipt">
            {summary.plans.map((p) => (
              <div className="bl-receipt__row" key={p.key || p.name}>
                <span>{p.quantity > 1 ? `${p.name} × ${p.quantity}` : p.name}</span>
                <span className="v">{p.prices.length ? p.prices.map((pr) => formatPrice(pr)).join(" · ") : "—"}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {periodRows.length > 0 && (
        <>
          <div className="bl-sublabel">Billing period</div>
          <div className="bl-receipt">
            {periodRows.map(([k, v]) => (
              <div className="bl-receipt__row" key={k}><span>{k}</span><span className="v">{v}</span></div>
            ))}
          </div>
        </>
      )}

      <div className="bl-sublabel">Payment method</div>
      <div className="bl-receipt">
        {summary.paymentMethods === null && (
          <div className="bl-receipt__empty">Payment methods can't be read right now.</div>
        )}
        {summary.paymentMethods?.length === 0 && (
          <div className="bl-receipt__row">
            <span>No saved payment method</span>
            <button className="link" onClick={() => open(links.paymentMethod)}>Add one</button>
          </div>
        )}
        {summary.paymentMethods?.map((m, i) => {
          const exp = formatExpiry(m);
          // Only the card the next charge goes to can make that charge fail.
          const isCharged = m === charged;
          const expiring = isCharged && cardExpiresBefore(m, nextChargeAt);
          return (
            <div className="bl-receipt__row" key={`${m.brand}-${m.last4}-${i}`}>
              <span className="bl-pm">
                <span className="v">{brandLabel(m.brand)} •••• {m.last4 || "????"}</span>
                {m.isDefault && <span className="bl-chip neutral"><span className="d" />Default</span>}
              </span>
              <span className="bl-row-end">
                {exp && <span className={expiring ? "bl-exp bl-exp--warn" : "bl-exp"}>{expiring ? `Expires ${exp} · before your next charge` : `Expires ${exp}`}</span>}
                <button className="link" onClick={() => open(links.paymentMethod)}>Update</button>
              </span>
            </div>
          );
        })}
      </div>

      <div className="bl-sublabel">Billing history</div>
      <div className="bl-receipt">
        {summary.payments.length === 0 && <div className="bl-receipt__empty">No payments yet.</div>}
        {payments.map((p) => {
          const row = paymentRow(p);
          const date = formatDate(p.paidAt);
          return (
            <div className="bl-receipt__row" key={p.id}>
              <span>{date ? `${date} · ` : ""}{row.label}</span>
              <span className="bl-row-end">
                <span className="v">
                  {row.amount}
                  {row.tax && <span className="bl-tax"> incl. {row.tax} tax</span>}
                </span>
                {isHttpsUrl(p.invoiceUrl) && <button className="link" onClick={() => open(p.invoiceUrl!)}>Invoice</button>}
                {isHttpsUrl(p.invoicePdfUrl) && <button className="link" onClick={() => open(p.invoicePdfUrl!)}>PDF</button>}
              </span>
            </div>
          );
        })}
        {!showAll && summary.payments.length > HISTORY_PREVIEW && (
          <div className="bl-receipt__row">
            <button className="link" onClick={onShowAll}>Show all {summary.payments.length} payments</button>
          </div>
        )}
      </div>

      <div className="bl-sublabel">Account</div>
      <div className="bl-receipt">
        {summary.account.email && (
          <div className="bl-receipt__row"><span>Billing email</span><span className="v">{summary.account.email}</span></div>
        )}
        <div className="bl-receipt__row">
          <span>Invoices, receipts and billing details</span>
          <button className="link" onClick={() => open(links.manage)}>Manage <ExternalLink size={11} strokeWidth={2} /></button>
        </div>
      </div>

      <div className="bl-foot">
        <span>
          {stale ? "Couldn't refresh · showing your last read" : readAt ? `Updated ${new Date(readAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}
          {" · "}Changes open your account in the browser.
        </span>
        <button className="bl-foot__refresh" onClick={onRefresh} aria-label="Refresh billing">
          <RefreshCw size={12} strokeWidth={2} /> Refresh
        </button>
      </div>
    </div>
  );
}
