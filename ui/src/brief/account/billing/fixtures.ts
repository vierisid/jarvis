import type {
  BillingSummary,
  BillingLinks,
} from "../../../v2/billing/billing-view";
import type { BillingFixture } from "./BillingWorkspace";

/** Synthetic preview values only; never a live fallback. */
export const BILLING_EXAMPLES = [
  "active",
  "trial",
  "grace",
  "past-due",
  "canceling",
  "incomplete",
  "restricted",
  "blocked",
  "no-plan",
  "self-hosted",
  "loading",
  "missing",
  "degraded",
  "old-response",
  "mixed-currency",
  "multiple-prices",
  "undated-charge",
  "long-history",
] as const;
export type BillingExample = (typeof BILLING_EXAMPLES)[number];
export const BILLING_NOW = Date.parse("2026-10-13T12:00:00Z");
export const BILLING_LINKS: BillingLinks = {
  page: "https://billing.example.test/",
  manage: "https://billing.example.test/?action=manage",
  paymentMethod: "https://billing.example.test/?action=payment-method",
  changePlan: "https://billing.example.test/?action=change-plan",
  cancel: "https://billing.example.test/?action=cancel",
};
export function makeBillingFixture(
  example: BillingExample = "active",
  open: (url: string) => boolean = () => true,
  refresh = () => {},
): BillingFixture {
  const summary: BillingSummary = {
    account: { email: "owner@example.test" },
    subscription: {
      status: "active",
      currentPeriodStart: "2026-10-01T12:00:00Z",
      currentPeriodEnd: "2026-11-01T12:00:00Z",
      startedAt: "2026-09-01T12:00:00Z",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      graceUntil: null,
    },
    plans: [
      {
        key: "preview",
        name: "Preview plan",
        quantity: 1,
        prices: [{ unitAmount: 8500, currency: "EUR", interval: "month" }],
      },
    ],
    upcomingInvoice: null,
    paymentMethods: [
      {
        brand: "visa",
        last4: "4242",
        expMonth: 8,
        expYear: 2028,
        isDefault: true,
      },
    ],
    payments: [0, 1].map((i) => ({
      id: `preview-${i}`,
      amountCents: 7000,
      taxCents: 1500,
      currency: "EUR",
      paidAt: `2026-${String(10 - i).padStart(2, "0")}-01T12:00:00Z`,
      invoiceNumber: `PREVIEW-${i + 1}`,
      invoiceUrl: `https://billing.example.test/invoice/${i}`,
      invoicePdfUrl: `https://billing.example.test/invoice/${i}.pdf`,
    })),
  };
  const fixture: BillingFixture = {
    source: "fixture",
    now: BILLING_NOW,
    open,
    refresh,
    billing: {
      state: "ready",
      summary,
      links: { ...BILLING_LINKS },
      stale: false,
      readAt: BILLING_NOW,
    },
    budget: {
      state: "hosted",
      readAt: BILLING_NOW,
      meter: {
        entitled: true,
        blocked: false,
        sessionPct: 35,
        weekPct: 62,
        sessionResetsAt: "2026-10-13T16:00:00Z",
        weekResetsAt: "2026-10-19T00:00:00Z",
        restricted: null,
      },
    },
  };
  switch (example) {
    case "trial":
      summary.subscription!.status = "trialing";
      break;
    case "grace":
      summary.subscription!.status = "past_due";
      summary.subscription!.graceUntil = "2026-10-20T12:00:00Z";
      break;
    case "past-due":
      summary.subscription!.status = "unpaid";
      summary.subscription!.graceUntil = "2026-10-10T12:00:00Z";
      break;
    case "canceling":
      summary.subscription!.cancelAtPeriodEnd = true;
      break;
    case "incomplete":
      summary.subscription!.status = "incomplete";
      break;
    case "restricted":
      fixture.budget.meter!.restricted = {
        reason: "account_suspended",
        contact: "support@example.test",
      };
      fixture.budget.meter!.entitled = false;
      break;
    case "blocked":
      fixture.budget.meter!.blocked = true;
      break;
    case "no-plan":
      summary.plans = [];
      summary.subscription = null;
      summary.payments = [];
      summary.paymentMethods = [];
      fixture.budget.meter!.entitled = false;
      break;
    case "self-hosted":
      fixture.billing = {
        state: "self",
        summary: null,
        links: null,
        readAt: BILLING_NOW,
        stale: false,
      };
      fixture.budget = { state: "self", meter: null, readAt: BILLING_NOW };
      break;
    case "loading":
      fixture.billing = {
        state: "unknown",
        summary: null,
        links: null,
        readAt: 0,
        stale: false,
      };
      break;
    case "missing":
      fixture.billing.state = "unavailable";
      fixture.billing.summary = null;
      break;
    case "degraded":
      fixture.billing.stale = true;
      fixture.budget.meter!.sessionPct = null;
      break;
    case "old-response":
      delete (summary as Partial<BillingSummary>).paymentMethods;
      delete (summary as Partial<BillingSummary>).upcomingInvoice;
      fixture.budget.meter = null;
      break;
    case "mixed-currency":
      summary.plans.push({
        key: "addon",
        name: "Additional workspace",
        quantity: 2,
        prices: [{ unitAmount: 1200, currency: "JPY", interval: "year" }],
      });
      summary.payments.push({
        ...summary.payments[0]!,
        id: "refund",
        amountCents: -1200,
        taxCents: 0,
        currency: "JPY",
        invoiceNumber: null,
      });
      break;
    case "long-history":
      summary.account.email =
        "averylongworkspaceowneraddressforlayouttesting@example.test";
      summary.plans[0]!.name =
        "A longer workspace plan name with multiple words and averylongunbrokenidentifierforlayouttesting";
      summary.payments = Array.from({ length: 18 }, (_, i) => ({
        ...summary.payments[i % 2]!,
        id: `history-${i}`,
        invoiceNumber: `PREVIEW-LONG-INVOICE-IDENTIFIER-${i}`,
      }));
      break;
    case "multiple-prices":
      summary.plans[0]!.prices.push({
        unitAmount: 85000,
        currency: "EUR",
        interval: "year",
      });
      break;
    case "undated-charge":
      summary.subscription!.currentPeriodEnd = null;
      summary.upcomingInvoice = {
        amountDueCents: 10370,
        currency: "EUR",
        date: null,
      };
      break;
  }
  return fixture;
}
