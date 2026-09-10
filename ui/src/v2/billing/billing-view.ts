/**
 * The Settings -> Billing page and the shell banner, as pure decisions.
 *
 * Pure on purpose: every rule here holds at a boundary (a grace window that
 * just passed, a card expiring this month, a refund, a cancel scheduled for a
 * date) that JSX tests cannot reach. Anything that depends on the time takes
 * `now` rather than reading the clock. Mirrors the daemon's summary types
 * (src/daemon/hosted-billing.ts), which in turn mirror the control plane's
 * wire contract (docs/BILLING.md "Billing inside the brain").
 */

export interface BillingPrice {
  interval: string;
  unitAmount: number;
  currency: string;
}

export interface BillingPlan {
  key: string;
  name: string;
  quantity: number;
  prices: BillingPrice[];
}

export interface BillingSubscription {
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  graceUntil: string | null;
  startedAt: string | null;
}

export interface BillingPaymentMethod {
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

export interface BillingPayment {
  id: string;
  amountCents: number;
  taxCents: number;
  currency: string;
  paidAt: string;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export interface BillingSummary {
  account: { email: string };
  subscription: BillingSubscription | null;
  plans: BillingPlan[];
  upcomingInvoice: { amountDueCents: number; currency: string; date: string | null } | null;
  paymentMethods: BillingPaymentMethod[] | null;
  payments: BillingPayment[];
}

export interface BillingLinks {
  page: string;
  manage: string;
  paymentMethod: string;
  changePlan: string;
  cancel: string;
}

export type BillingTone = "info" | "ok" | "warn" | "neutral" | "danger";

// ── The route's answer ─────────────────────────────────────────────────────

/**
 * What one read of GET /api/billing means.
 *
 * TRI-state for the reason the usage meter is (useHostedBudget.ts): a failed
 * fetch or an unparseable body is "failed", which the page renders as unknown
 * and retries, never as "you have no bill".
 */
export type BillingProbe =
  | { kind: "self" }
  | { kind: "ready"; summary: BillingSummary; links: BillingLinks }
  | { kind: "unavailable"; links: BillingLinks | null }
  | { kind: "failed" };

export function classifyBillingResponse(status: number, body: unknown): BillingProbe {
  // Self-hosted only when the DAEMON says so: its 503 carries a JSON error. A
  // bare 503 from something in between (a proxy, a restarting host) is a failed
  // read — otherwise a hosted user would be told "no bill here" until a reload,
  // since "self" stops the polling.
  if (status === 503) {
    const err = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    return typeof err === "string" ? { kind: "self" } : { kind: "failed" };
  }
  if (status !== 200 || !body || typeof body !== "object") return { kind: "failed" };
  const b = body as { ok?: unknown; summary?: unknown; links?: unknown };
  const links = isLinks(b.links) ? b.links : null;
  if (b.ok === true && b.summary && typeof b.summary === "object" && links) {
    return { kind: "ready", summary: b.summary as BillingSummary, links };
  }
  if (b.ok === false) return { kind: "unavailable", links };
  return { kind: "failed" };
}

function isLinks(v: unknown): v is BillingLinks {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return (["page", "manage", "paymentMethod", "changePlan", "cancel"] as const).every(
    (k) => typeof l[k] === "string" && /^https?:\/\//.test(l[k] as string),
  );
}

/**
 * The only URLs this page opens that do not come from `links`: receipts. The
 * daemon already drops anything else; checked again here so the invariant holds
 * where the click happens.
 */
export function isHttpsUrl(v: string | null): v is string {
  return typeof v === "string" && /^https:\/\//.test(v);
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Minor units -> "$9.99". Currency from the processor, never assumed, and so is
 * its exponent: a zero-decimal currency (JPY) is not divided by 100.
 */
export function formatMoney(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: code });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(minor / 10 ** digits);
  } catch {
    // An unknown code must not blank the page.
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
}

/** "Oct 1, 2026". Null for a missing or unparseable date, so callers can omit it. */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(t);
}

/** A date that is known and still ahead. Past or missing dates are not promised to anyone. */
function futureDate(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > now ? formatDate(iso) : null;
}

const INTERVAL_SUFFIX: Record<string, string> = { month: "/ mo", year: "/ yr" };

/** "$9.99 / mo", or "" when the plan has no price. Month is listed first upstream. */
export function formatPrice(price: BillingPrice | undefined): string {
  if (!price) return "";
  const suffix = INTERVAL_SUFFIX[price.interval] ?? `/ ${price.interval}`;
  return `${formatMoney(price.unitAmount, price.currency)} ${suffix}`;
}

/** "Visa", "Sepa debit": the processor's lowercase brand, readable. */
export function brandLabel(brand: string): string {
  const clean = brand.replace(/_/g, " ").trim();
  if (!clean) return "Card";
  if (clean.toLowerCase() === "amex") return "American Express";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** "08 / 27", or null for a method without an expiry. */
export function formatExpiry(m: BillingPaymentMethod): string | null {
  if (m.expMonth === null || m.expYear === null) return null;
  return `${String(m.expMonth).padStart(2, "0")} / ${String(m.expYear % 100).padStart(2, "0")}`;
}

/**
 * True when the card stops working on or before `iso`. Expiry is the END of
 * the stated month.
 */
export function cardExpiresBefore(m: BillingPaymentMethod, iso: string | null): boolean {
  if (m.expMonth === null || m.expYear === null || !iso) return false;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  const endOfExpiryMonth = Date.UTC(m.expYear, m.expMonth, 1); // first instant of the NEXT month
  return endOfExpiryMonth <= at;
}

/**
 * The card the next charge goes to: the default, or the only card. With several
 * cards and no known default this is null, and nothing claims to know.
 */
export function chargedCard(summary: BillingSummary): BillingPaymentMethod | null {
  const methods = summary.paymentMethods ?? [];
  return methods.find((m) => m.isDefault) ?? (methods.length === 1 ? methods[0]! : null);
}

// ── State ──────────────────────────────────────────────────────────────────

/**
 * The lifecycle state the design names (usejarvis-billing-states), derived
 * from what the processor actually says.
 *
 * `expired` exists in the design but cannot reach this page: when a
 * subscription ends the control plane stops this brain. It maps to "none" so a
 * summary read in the last seconds before suspension renders honestly.
 */
export type BillingState = "active" | "past_due" | "canceling" | "incomplete" | "none";

export function billingState(sub: BillingSubscription | null): BillingState {
  if (!sub) return "none";
  switch (sub.status) {
    case "active":
    case "trialing":
      return sub.cancelAtPeriodEnd || sub.cancelAt ? "canceling" : "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "incomplete":
      return "incomplete";
    default:
      return "none";
  }
}

export const STATE_CHIP: Record<BillingState, { tone: BillingTone; label: string }> = {
  active: { tone: "ok", label: "Active" },
  past_due: { tone: "warn", label: "Past due" },
  canceling: { tone: "neutral", label: "Canceling" },
  incomplete: { tone: "warn", label: "Incomplete" },
  none: { tone: "neutral", label: "No plan" },
};

/** When a canceling subscription actually ends. */
export function endsAt(sub: BillingSubscription): string | null {
  return sub.cancelAt ?? sub.currentPeriodEnd;
}

/** When the next charge is due: Stripe's preview, else the renewal date of an active plan. */
export function nextChargeDate(summary: BillingSummary): string | null {
  if (billingState(summary.subscription) !== "active") return null;
  return summary.upcomingInvoice?.date ?? summary.subscription?.currentPeriodEnd ?? null;
}

/**
 * Something on the page will need the user before the next charge: no card to
 * charge, cards that cannot be read, or the charged card expiring first. The
 * quiet "All good" line must never sit above any of these.
 */
export function needsAttention(summary: BillingSummary): boolean {
  if (billingState(summary.subscription) !== "active") return false;
  if (summary.paymentMethods === null || summary.paymentMethods.length === 0) return true;
  const card = chargedCard(summary);
  return !!card && cardExpiresBefore(card, nextChargeDate(summary));
}

/** "Base + Disk × 2". */
export function planTitle(plans: BillingPlan[]): string {
  if (plans.length === 0) return "No active plan";
  return plans.map((p) => (p.quantity > 1 ? `${p.name} × ${p.quantity}` : p.name)).join(" + ");
}

/**
 * The recurring total across every plan, when they share one currency and one
 * interval (the only case a single figure is honest for). Null otherwise; the
 * per-plan rows still show each price.
 */
export function recurringTotal(plans: BillingPlan[]): BillingPrice | null {
  const firsts = plans.map((p) => p.prices[0]);
  if (firsts.length === 0 || firsts.some((p) => !p)) return null;
  const [head] = firsts as BillingPrice[];
  if (!(firsts as BillingPrice[]).every((p) => p.currency === head!.currency && p.interval === head!.interval)) {
    return null;
  }
  const total = plans.reduce((sum, p) => sum + p.prices[0]!.unitAmount * Math.max(1, p.quantity), 0);
  return { interval: head!.interval, unitAmount: total, currency: head!.currency };
}

/**
 * The one line under the plan name: what happens next, and when. `**bold**`
 * markers like the design's copy. A date already behind `now` is dropped rather
 * than promised.
 */
export function planMeta(summary: BillingSummary, now: number): string {
  const sub = summary.subscription;
  if (!sub) return "You don't have a subscription on this account.";
  const card = chargedCard(summary);
  const cardText = card ? ` · ${brandLabel(card.brand)} •••• ${card.last4 || "????"}` : "";
  switch (billingState(sub)) {
    case "active": {
      const next = summary.upcomingInvoice;
      const nextOn = next ? formatDate(next.date) : null;
      if (next && nextOn) {
        return `Next charge **${formatMoney(next.amountDueCents, next.currency)}** on **${nextOn}**${cardText}`;
      }
      const renew = formatDate(sub.currentPeriodEnd);
      return renew ? `Renews **${renew}**${cardText}` : `Renews automatically${cardText}`;
    }
    case "canceling": {
      const end = futureDate(endsAt(sub), now);
      return end
        ? `Ends **${end}** · you keep everything until then, and can resume any time before`
        : "Set to end at the close of this period · you can resume any time before it does";
    }
    case "past_due": {
      const grace = futureDate(sub.graceUntil, now);
      return grace
        ? `Payment failed · your brain stays online until **${grace}**`
        : "Payment failed · update your card to keep Jarvis running";
    }
    case "incomplete":
      return "The first payment hasn't completed yet.";
    default:
      return "This subscription is no longer active.";
  }
}

export interface BannerView {
  tone: BillingTone;
  icon: "clock" | "alert" | "info";
  message: string;
  action: { label: string; link: keyof BillingLinks };
}

/**
 * The top-of-app banner, or null. Active is quiet: nothing needs you. The
 * others speak exactly as much as the situation warrants.
 */
export function bannerFor(summary: BillingSummary, now: number): BannerView | null {
  const sub = summary.subscription;
  switch (billingState(sub)) {
    case "past_due": {
      const grace = futureDate(sub?.graceUntil ?? null, now);
      return {
        tone: "warn",
        icon: "alert",
        message: grace
          ? `**We couldn't charge your card.** Update it to keep Jarvis running; your brain stays online until ${grace}.`
          : "**We couldn't charge your card.** Update it to keep Jarvis running.",
        action: { label: "Update card", link: "paymentMethod" },
      };
    }
    case "canceling": {
      const end = futureDate(sub ? endsAt(sub) : null, now);
      return {
        tone: "neutral",
        icon: "info",
        message: end
          ? `Your subscription is **canceled**. You have access until ${end}.`
          : "Your subscription is **canceled** and ends with this period.",
        action: { label: "Resume", link: "manage" },
      };
    }
    case "incomplete":
      return {
        tone: "warn",
        icon: "alert",
        message: "**Your first payment hasn't completed.** Finish it to keep Jarvis running.",
        action: { label: "Open billing", link: "manage" },
      };
    default:
      return null;
  }
}

/** A refund row reads as a refund, with its sign. Gross = net + tax. */
export function paymentRow(p: BillingPayment): { label: string; amount: string; tax: string | null; refund: boolean } {
  const gross = p.amountCents + p.taxCents;
  const refund = gross < 0;
  return {
    label: refund ? "Refund" : p.invoiceNumber ? `Invoice ${p.invoiceNumber}` : "Payment",
    amount: formatMoney(gross, p.currency),
    tax: !refund && p.taxCents !== 0 ? formatMoney(p.taxCents, p.currency) : null,
    refund,
  };
}

/** Split `**bold**` copy into segments; odd segments are bold. */
export function boldSegments(text: string): Array<{ text: string; bold: boolean }> {
  return text.split("**").map((part, i) => ({ text: part, bold: i % 2 === 1 }));
}
