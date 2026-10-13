import React, { useState } from "react";
import { ArrowUpRight, CreditCard } from "lucide-react";
import type { BriefShellPort } from "../../contracts";
import { BriefButton } from "../../components/controls";
import {
  useBilling,
  type BillingSnapshot,
} from "../../../v2/billing/useBilling";
import {
  useHostedBudget,
  type HostedBudget,
} from "../../../v2/rooms/usage/useHostedBudget";
import {
  billingState,
  STATE_CHIP,
  planTitle,
  recurringTotal,
  formatPrice,
  planMeta,
  boldSegments,
  brandLabel,
  formatExpiry,
  cardExpiresBefore,
  nextChargeDate,
  formatDate,
  paymentRow,
  type BillingLinks,
} from "../../../v2/billing/billing-view";
import {
  bannerFor,
  barWidthPct,
  formatPct,
  meterTone,
} from "../../../v2/rooms/usage/hosted-budget";
import {
  openExternal,
  openedOrHandedOff,
} from "../../../v2/onboarding/external-open";
import { externalUrl, readableMeter, readableSummary } from "./model";
import "./billing.css";

export interface BillingFixture {
  source: "fixture";
  billing: BillingSnapshot;
  budget: Omit<HostedBudget, "refresh">;
  refresh: () => void;
  open: (url: string) => boolean;
  now: number;
}

/** Preview must receive an explicit fixture. A live room never consumes it or falls back to samples. */
export function BillingWorkspace({
  shell,
  fixture,
}: {
  shell: BriefShellPort;
  fixture?: BillingFixture;
}) {
  if (shell.mode === "preview" && fixture?.source === "fixture")
    return <BillingContent {...fixture} />;
  if (shell.mode === "live" && !fixture) return <LiveBilling />;
  return (
    <section className="brief-billing">
      <h1 className="brief-type-room-title">Billing</h1>
      <p role="status">Billing is unavailable in this view.</p>
    </section>
  );
}

function LiveBilling() {
  const billing = useBilling();
  const budget = useHostedBudget();
  return (
    <BillingContent
      billing={billing}
      budget={budget}
      now={Date.now()}
      refresh={() => {
        billing.refresh();
        budget.refresh();
      }}
      open={(url) => openedOrHandedOff(openExternal(url))}
    />
  );
}

function StrongCopy({ text }: { text: string }) {
  return (
    <>
      {boldSegments(text).map((part, i) =>
        part.bold ? <strong key={i}>{part.text}</strong> : part.text,
      )}
    </>
  );
}

function BillingContent({
  billing,
  budget,
  refresh,
  open,
  now,
  source,
}: Omit<BillingFixture, "source"> & { source?: "fixture" }) {
  const [expanded, setExpanded] = useState(false);
  const [openError, setOpenError] = useState(false);
  const summary =
    billing.state === "ready" ? readableSummary(billing.summary) : null;
  const meter = budget.state === "hosted" ? readableMeter(budget.meter) : null;
  const go = (url: string) => {
    try {
      setOpenError(!open(url));
    } catch {
      setOpenError(true);
    }
  };
  const action = (label: string, key: keyof BillingLinks, quiet = false) => {
    const url = externalUrl(billing.links?.[key]);
    return url ? (
      <BriefButton
        variant={quiet ? "text" : "secondary"}
        size="sm"
        icon={<ArrowUpRight size={14} />}
        onClick={() => go(url)}
      >
        {label}
      </BriefButton>
    ) : null;
  };
  const state = billingState(summary?.subscription ?? null);
  const total = summary ? recurringTotal(summary.plans) : null;
  const totalText =
    total && Number.isFinite(total.unitAmount) ? formatPrice(total) : null;
  const trial =
    summary?.subscription?.status === "trialing" && state === "active";
  const status = trial
    ? "Trial"
    : state === "none" && summary?.subscription
      ? summary.subscription.status.replaceAll("_", " ")
      : STATE_CHIP[state].label;
  const usageBanner = bannerFor(meter);
  return (
    <section className="brief-billing" aria-label="Billing">
      <header>
        <h1 className="brief-type-room-title">Billing</h1>
        <div>
          {source && <small>Illustrative data</small>}
          <BriefButton size="sm" onClick={refresh}>
            Refresh billing
          </BriefButton>
        </div>
      </header>
      <div role="status" className="brief-billing-feedback">
        {openError
          ? "Your browser did not open. Allow pop-ups and try the action again."
          : ""}
      </div>
      {billing.state === "self" ? (
        <p className="brief-billing-notice">
          This is a self-hosted workspace. There is no hosted subscription to
          manage here.
        </p>
      ) : !summary ? (
        <div className="brief-billing-notice" role="status">
          <h2>
            {billing.state === "unknown"
              ? "Loading billing…"
              : "Billing is unavailable"}
          </h2>
          <p>
            {billing.state === "unknown"
              ? "Waiting for your billing information. You can retry with Refresh billing."
              : "We couldn’t read your billing information. Refresh to try again."}
          </p>
          {action("Open billing", "page")}
        </div>
      ) : (
        <>
          {billing.stale && (
            <p className="brief-billing-notice" role="status">
              Billing could not be refreshed. Showing the last available details
              {billing.readAt
                ? ` from ${new Date(billing.readAt).toLocaleString()}`
                : ""}
              .
            </p>
          )}
          <section
            className="brief-billing-plan"
            aria-labelledby="billing-plan-title"
          >
            <div>
              <h2 id="billing-plan-title">Your plan</h2>
              <div className="brief-billing-plan-name">
                <h3>{planTitle(summary.plans)}</h3>
                <span
                  className="brief-billing-chip"
                  data-tone={STATE_CHIP[state].tone}
                >
                  {status}
                </span>
              </div>
              <p className="brief-billing-price">
                {totalText ??
                  (summary.plans.length
                    ? "See plan pricing below"
                    : "No recurring price reported")}
              </p>
              {trial && (
                <p>
                  {formatDate(summary.subscription?.currentPeriodEnd ?? null)
                    ? `Trial ends ${formatDate(summary.subscription!.currentPeriodEnd)}`
                    : "Trial end date unavailable"}
                </p>
              )}
              <p>
                <StrongCopy text={planMeta(summary, now)} />
              </p>
            </div>
            <div className="brief-billing-actions">
              {state === "active"
                ? action("Change plan", "changePlan")
                : state === "canceling"
                  ? action("Resume subscription", "manage")
                  : action(
                      state === "incomplete"
                        ? "Complete payment"
                        : "Open billing",
                      "manage",
                    )}
            </div>
            {(summary.plans.length > 1 ||
              (!totalText && summary.plans.length > 0)) && (
              <ul className="brief-billing-plan-lines">
                {summary.plans.map((plan, i) => (
                  <li key={`${plan.key}:${i}`}>
                    <span>
                      {plan.name}
                      {plan.quantity > 1 ? ` × ${plan.quantity}` : ""}
                    </span>
                    <span>
                      {plan.prices.length
                        ? plan.prices.map((p) => formatPrice(p)).join(" · ") +
                          (plan.quantity > 1 ? " each" : "")
                        : "Price unavailable"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section
            className="brief-billing-section"
            aria-labelledby="billing-usage-title"
          >
            <div className="brief-billing-section-heading">
              <h2 id="billing-usage-title">AI usage</h2>
              <small>Last reported usage</small>
            </div>
            {usageBanner && (
              <p className="brief-billing-notice" role="status">
                {usageBanner.text}
              </p>
            )}
            {!meter ? (
              <p>
                {budget.state === "self"
                  ? "Hosted AI usage is not enabled for this workspace."
                  : "Usage is unavailable. Refresh to try again."}
              </p>
            ) : !meter.entitled ? (
              <p>No included AI usage is reported for this account.</p>
            ) : (
              !meter.restricted && (
                <div className="brief-billing-meters">
                  {(
                    [
                      [
                        "6-hour window",
                        meter.sessionPct,
                        meter.sessionResetsAt,
                      ],
                      ["This week", meter.weekPct, meter.weekResetsAt],
                    ] as const
                  ).map(([label, pct, reset]) => (
                    <div key={label} className="brief-billing-meter">
                      <div>
                        <span>{label}</span>
                        <strong>{formatPct(pct)}</strong>
                      </div>
                      <div
                        className="brief-billing-track"
                        role={pct === null ? undefined : "meter"}
                        aria-label={label}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={
                          pct === null ? undefined : barWidthPct(pct)
                        }
                        aria-valuetext={formatPct(pct)}
                        data-tone={meterTone(pct)}
                      >
                        <span style={{ width: `${barWidthPct(pct)}%` }} />
                      </div>
                      <small>
                        {!reset
                          ? "Reset date unavailable"
                          : Date.parse(reset) <= now
                            ? "Awaiting updated usage"
                            : `Resets ${new Date(reset).toLocaleString()}`}
                      </small>
                    </div>
                  ))}
                </div>
              )
            )}
            <p className="brief-billing-caption">
              Usage is reported as a percentage of each window. Availability can
              also depend on account restrictions.
            </p>
          </section>
          <section
            className="brief-billing-section"
            aria-labelledby="billing-payment-title"
          >
            <div className="brief-billing-section-heading">
              <h2 id="billing-payment-title">Payment method</h2>
              {action("Update card", "paymentMethod")}
            </div>
            {summary.paymentMethods === null ? (
              <p>Payment methods are unavailable.</p>
            ) : summary.paymentMethods.length === 0 ? (
              <p>No saved payment method.</p>
            ) : (
              summary.paymentMethods.map((method, i) => (
                <div
                  className="brief-billing-method"
                  key={`${method.brand}:${method.last4}:${i}`}
                >
                  <CreditCard size={24} aria-hidden="true" />
                  <div>
                    <strong>
                      {brandLabel(method.brand)}
                      {method.last4 ? ` •••• ${method.last4}` : ""}
                    </strong>
                    {method.isDefault && <small>Default</small>}
                    <p>
                      {formatExpiry(method)
                        ? `Expires ${formatExpiry(method)}`
                        : "Expiry unavailable"}
                      {cardExpiresBefore(method, nextChargeDate(summary)) &&
                        " · Expires before the next charge"}
                    </p>
                  </div>
                </div>
              ))
            )}
          </section>
          <section
            className="brief-billing-section"
            aria-labelledby="billing-history-title"
          >
            <h2 id="billing-history-title">Billing history</h2>
            {summary.payments.length === 0 ? (
              <p>No payments reported.</p>
            ) : (
              <>
                <table className="brief-billing-history">
                  <caption className="brief-sr-only">
                    Billing payments and refunds
                  </caption>
                  <thead>
                    <tr>
                      {["Date", "Amount", "Status", "Document"].map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.payments
                      .slice(0, expanded ? undefined : 12)
                      .map((payment, i) => {
                        const row = paymentRow(payment);
                        return (
                          <tr key={payment.id || `${payment.paidAt}:${i}`}>
                            <td data-label="Date">
                              <time dateTime={payment.paidAt}>
                                {formatDate(payment.paidAt)}
                              </time>
                            </td>
                            <td data-label="Amount">
                              <strong>{row.amount}</strong>
                              {row.tax && <small>Includes {row.tax} tax</small>}
                            </td>
                            <td data-label="Status">
                              {row.refund ? "Refund" : "Paid"}
                            </td>
                            <td data-label="Document">
                              <span>{row.label}</span>
                              <div>
                                {payment.invoiceUrl && (
                                  <BriefButton
                                    size="sm"
                                    variant="text"
                                    aria-label={`View ${row.label}, ${formatDate(payment.paidAt)}`}
                                    onClick={() => go(payment.invoiceUrl!)}
                                  >
                                    View
                                  </BriefButton>
                                )}
                                {payment.invoicePdfUrl && (
                                  <BriefButton
                                    size="sm"
                                    variant="text"
                                    aria-label={`PDF for ${row.label}, ${formatDate(payment.paidAt)}`}
                                    onClick={() => go(payment.invoicePdfUrl!)}
                                  >
                                    PDF
                                  </BriefButton>
                                )}
                                {!payment.invoiceUrl &&
                                  !payment.invoicePdfUrl && (
                                    <small>Unavailable</small>
                                  )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
                {summary.payments.length > 12 && (
                  <BriefButton
                    size="sm"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded
                      ? "Show recent payments"
                      : `Show all ${summary.payments.length} payments`}
                  </BriefButton>
                )}
              </>
            )}
          </section>
          <footer>
            <div>
              <p>Billing changes open in your browser.</p>
              {summary.account.email && <p>{summary.account.email}</p>}
            </div>
            <div>
              {action("Manage billing", "manage", true)}
              {state === "active" &&
                action("Cancel subscription", "cancel", true)}
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
