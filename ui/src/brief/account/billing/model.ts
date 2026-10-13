import type { BillingSummary } from "../../../v2/billing/billing-view";
import type { HostedMeter } from "../../../v2/rooms/usage/hosted-budget";

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const text = (v: unknown): v is string => typeof v === "string";
const date = (v: unknown): string | null =>
  text(v) && Number.isFinite(Date.parse(v)) ? v : null;
const currency = (v: unknown): v is string => text(v) && /^[a-z]{3}$/i.test(v);

/** Validate at the presentation boundary too: the shared hook accepts old daemon responses. */
export function readableSummary(value: unknown): BillingSummary | null {
  if (
    !record(value) ||
    !Array.isArray(value.plans) ||
    !Array.isArray(value.payments)
  )
    return null;
  const plans: BillingSummary["plans"] = [];
  for (const p of value.plans) {
    if (
      !record(p) ||
      !text(p.name) ||
      !Array.isArray(p.prices) ||
      !finite(p.quantity) ||
      p.quantity < 1
    )
      return null;
    const prices: BillingSummary["plans"][number]["prices"] = [];
    for (const price of p.prices) {
      if (
        !record(price) ||
        !finite(price.unitAmount) ||
        !currency(price.currency) ||
        !text(price.interval) ||
        !price.interval
      )
        return null;
      prices.push({
        unitAmount: price.unitAmount,
        currency: price.currency.toUpperCase(),
        interval: price.interval,
      });
    }
    plans.push({
      key: text(p.key) ? p.key : "",
      name: p.name,
      quantity: p.quantity,
      prices,
    });
  }
  const payments: BillingSummary["payments"] = [];
  for (const p of value.payments) {
    if (
      !record(p) ||
      !finite(p.amountCents) ||
      !finite(p.taxCents ?? 0) ||
      !currency(p.currency) ||
      !date(p.paidAt)
    )
      return null;
    if (!Number.isFinite(p.amountCents + Number(p.taxCents ?? 0))) return null;
    payments.push({
      id: text(p.id) ? p.id : "",
      amountCents: p.amountCents,
      taxCents: Number(p.taxCents ?? 0),
      currency: p.currency,
      paidAt: p.paidAt as string,
      invoiceNumber: text(p.invoiceNumber) ? p.invoiceNumber : null,
      invoiceUrl: externalUrl(p.invoiceUrl, true),
      invoicePdfUrl: externalUrl(p.invoicePdfUrl, true),
    });
  }
  let subscription: BillingSummary["subscription"] = null;
  const sub = value.subscription;
  if (sub != null) {
    if (!record(sub) || !text(sub.status)) return null;
    subscription = {
      status: sub.status,
      currentPeriodStart: date(sub.currentPeriodStart),
      currentPeriodEnd: date(sub.currentPeriodEnd),
      startedAt: date(sub.startedAt),
      cancelAt: date(sub.cancelAt),
      graceUntil: date(sub.graceUntil),
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
    };
  }
  let paymentMethods: BillingSummary["paymentMethods"] = null;
  if (Array.isArray(value.paymentMethods)) {
    paymentMethods = [];
    for (const m of value.paymentMethods) {
      if (!record(m) || !text(m.brand)) {
        paymentMethods = null;
        break;
      }
      paymentMethods.push({
        brand: m.brand,
        last4: text(m.last4) ? m.last4 : "",
        expMonth:
          finite(m.expMonth) &&
          Number.isInteger(m.expMonth) &&
          m.expMonth >= 1 &&
          m.expMonth <= 12
            ? m.expMonth
            : null,
        expYear:
          finite(m.expYear) && Number.isInteger(m.expYear) && m.expYear > 0
            ? m.expYear
            : null,
        isDefault: m.isDefault === true,
      });
    }
  }
  const next = value.upcomingInvoice;
  const upcomingInvoice =
    record(next) && finite(next.amountDueCents) && currency(next.currency)
      ? {
          amountDueCents: next.amountDueCents,
          currency: next.currency,
          date: date(next.date),
        }
      : null;
  return {
    account: {
      email:
        record(value.account) && text(value.account.email)
          ? value.account.email
          : "",
    },
    plans,
    payments,
    subscription,
    paymentMethods,
    upcomingInvoice,
  };
}

export function externalUrl(value: unknown, receipt = false): string | null {
  if (!text(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" ||
      (!receipt && url.protocol === "http:")) &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

export function readableMeter(value: unknown): HostedMeter | null {
  if (
    !record(value) ||
    typeof value.entitled !== "boolean" ||
    typeof value.blocked !== "boolean" ||
    !(
      value.sessionPct === null ||
      (finite(value.sessionPct) && value.sessionPct >= 0)
    ) ||
    !finite(value.weekPct) ||
    value.weekPct < 0
  )
    return null;
  const restriction = value.restricted;
  if (
    restriction != null &&
    (!record(restriction) ||
      !["content_policy", "account_suspended", "account_banned"].includes(
        String(restriction.reason),
      ))
  )
    return null;
  return {
    entitled: value.entitled,
    blocked: value.blocked,
    sessionPct: value.sessionPct as number | null,
    weekPct: value.weekPct,
    sessionResetsAt: date(value.sessionResetsAt) ?? "",
    weekResetsAt: date(value.weekResetsAt) ?? "",
    restricted: record(restriction)
      ? {
          reason: restriction.reason as NonNullable<
            HostedMeter["restricted"]
          >["reason"],
          contact: text(restriction.contact) ? restriction.contact : null,
        }
      : null,
  };
}
