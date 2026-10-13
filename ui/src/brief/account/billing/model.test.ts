import { test, expect } from "bun:test";
import { readableSummary, readableMeter, externalUrl } from "./model";
import { makeBillingFixture, BILLING_NOW } from "./fixtures";
import {
  formatMoney,
  formatPrice,
  recurringTotal,
  paymentRow,
  planMeta,
  billingState,
} from "../../../v2/billing/billing-view";
import { parseHostedBillingSummary } from "../../../../../src/daemon/hosted-billing";

test("actual daemon parser and Brief tolerate sparse older provider responses", () => {
  const wire = { plans: [{ name: "Older plan", prices: [] }], payments: [] };
  const canonical = parseHostedBillingSummary(wire);
  expect(canonical).not.toBeNull();
  const view = readableSummary(canonical)!;
  expect(view.paymentMethods).toBeNull();
  expect(view.upcomingInvoice).toBeNull();
  expect(view.account.email).toBe("");
  expect(view.plans[0]!.prices).toEqual([]);
  expect(
    readableSummary(makeBillingFixture("old-response").billing.summary)
      ?.paymentMethods,
  ).toBeNull();
});
test("currency exponent, quantity, mixed currencies and refunds remain canonical", () => {
  expect(formatMoney(1200, "JPY")).toBe("¥1,200");
  expect(formatMoney(1200, "KWD")).toContain("1.200");
  const view = readableSummary(
    makeBillingFixture("mixed-currency").billing.summary,
  )!;
  expect(recurringTotal(view.plans)).toBeNull();
  expect(paymentRow(view.payments.at(-1)!)).toMatchObject({
    refund: true,
    amount: "-¥1,200",
    tax: null,
  });
  view.plans = [
    {
      key: "a",
      name: "Quantity",
      quantity: 2,
      prices: [{ unitAmount: 1200, currency: "JPY", interval: "year" }],
    },
  ];
  expect(formatPrice(recurringTotal(view.plans)!)).toBe("¥2,400 / yr");
});
test("missing or malformed values cannot become live prices, empty history or unrenderable fields", () => {
  for (const bad of [
    null,
    {},
    [],
    { plans: [], payments: null },
    { plans: null, payments: [] },
  ])
    expect(readableSummary(bad)).toBeNull();
  for (const patch of [
    { unitAmount: NaN },
    { unitAmount: Infinity },
    { currency: null },
    { currency: "" },
    { interval: {} },
  ]) {
    const summary = makeBillingFixture().billing.summary!;
    Object.assign(summary.plans[0]!.prices[0]!, patch);
    expect(readableSummary(summary)).toBeNull();
  }
  const summary = makeBillingFixture().billing.summary!;
  summary.payments[0]!.paidAt = "bad date";
  expect(readableSummary(summary)).toBeNull();
});
test("invalid optional dates and expiry are unavailable, not misleading calendar values", () => {
  const summary = makeBillingFixture().billing.summary!;
  summary.subscription!.currentPeriodEnd = "bad date";
  summary.paymentMethods![0]!.expMonth = 13;
  const view = readableSummary(summary)!;
  expect(view.subscription!.currentPeriodEnd).toBeNull();
  expect(view.paymentMethods![0]!.expMonth).toBeNull();
});
test("grace expiry and scheduled cancellation follow existing policy decisions", () => {
  expect(
    planMeta(
      readableSummary(makeBillingFixture("grace").billing.summary)!,
      BILLING_NOW,
    ),
  ).toContain("stays online until");
  expect(
    planMeta(
      readableSummary(makeBillingFixture("past-due").billing.summary)!,
      BILLING_NOW,
    ),
  ).not.toContain("stays online until");
  expect(
    billingState(makeBillingFixture("canceling").billing.summary!.subscription),
  ).toBe("canceling");
});
test("untrusted document and action URLs cannot execute or expose embedded credentials", () => {
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "https://",
    "https://user:password@example.test",
    {},
  ])
    expect(externalUrl(bad)).toBeNull();
  expect(externalUrl("http://localhost/billing")).toBe(
    "http://localhost/billing",
  );
  expect(externalUrl("http://localhost/invoice", true)).toBeNull();
  const summary = makeBillingFixture().billing.summary!;
  summary.payments[0]!.invoicePdfUrl = "javascript:alert(1)";
  expect(readableSummary(summary)!.payments[0]!.invoicePdfUrl).toBeNull();
});
test("usage null is unknown, legacy restrictions are optional, invalid readings fail closed", () => {
  const meter = makeBillingFixture("degraded").budget.meter!;
  delete (meter as Partial<typeof meter>).restricted;
  expect(readableMeter(meter)).toMatchObject({
    sessionPct: null,
    restricted: null,
  });
  for (const patch of [
    { weekPct: NaN },
    { sessionPct: -1 },
    { weekPct: null },
    { restricted: { reason: "unrecognized" } },
  ])
    expect(readableMeter({ ...meter, ...patch })).toBeNull();
});
