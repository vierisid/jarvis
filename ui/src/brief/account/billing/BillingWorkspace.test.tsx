import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  test,
  expect,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { BriefShellPort } from "../../contracts";
import {
  makeBillingFixture,
  BILLING_EXAMPLES,
  BILLING_LINKS,
} from "./fixtures";
import type { BillingFixture } from "./BillingWorkspace";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot,
  Workspace: typeof import("./BillingWorkspace").BillingWorkspace,
  useBilling: typeof import("../../../v2/billing/useBilling").useBilling;
let root: Root,
  host: HTMLDivElement,
  fixture: BillingFixture,
  opened: string[],
  reads: number;
const originalFetch = globalThis.fetch;
let originalOpen: typeof window.open;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ BillingWorkspace: Workspace } = await import("./BillingWorkspace"));
  ({ useBilling } = await import("../../../v2/billing/useBilling"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  opened = [];
  reads = 0;
  fixture = makeBillingFixture(
    "active",
    (url) => {
      opened.push(url);
      return true;
    },
    () => reads++,
  );
  globalThis.fetch = (() => {
    throw Error("Preview attempted a network request");
  }) as unknown as typeof fetch;
  originalOpen = window.open;
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  host.remove();
  globalThis.fetch = originalFetch;
  window.open = originalOpen;
  delete window.__jarvisOpensExternally;
});
afterAll(() => GlobalRegistrator.unregister());
function shell(overrides: Partial<BriefShellPort> = {}): BriefShellPort {
  return {
    mode: "preview",
    route: { room: "billing", selection: {} },
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme() {},
    setSidebar() {},
    setChatOpen() {},
    navigate() {},
    ...overrides,
  };
}
async function render(
  overrides: Partial<BriefShellPort> = {},
  f: BillingFixture | undefined = fixture,
) {
  await React.act(async () =>
    root.render(<Workspace shell={shell(overrides)} fixture={f} />),
  );
}
function button(label: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (n) =>
      (
        n.querySelector(".brief-button__label")?.textContent ?? n.textContent
      )?.trim() === label,
  );
  if (!node) throw Error(`Missing ${label}`);
  return node;
}
async function click(label: string) {
  await React.act(async () => button(label).click());
}

test("plan, usage, payment and history use provided data and every action hands off exactly once", async () => {
  await render();
  expect([...host.querySelectorAll("h2")].map((n) => n.textContent)).toEqual([
    "Your plan",
    "AI usage",
    "Payment method",
    "Billing history",
  ]);
  expect(host.textContent).toContain("€85.00");
  expect(host.textContent).toContain("35%");
  expect(host.textContent).toContain("Includes €15.00 tax");
  expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
  for (const [label, url] of [
    ["Change plan", BILLING_LINKS.changePlan],
    ["Update card", BILLING_LINKS.paymentMethod],
    ["Manage billing", BILLING_LINKS.manage],
    ["Cancel subscription", BILLING_LINKS.cancel],
    ["View", fixture.billing.summary!.payments[0]!.invoiceUrl!],
    ["PDF", fixture.billing.summary!.payments[0]!.invoicePdfUrl!],
  ]) {
    await click(label!);
    expect(opened.at(-1)).toBe(url);
  }
  expect(opened).toHaveLength(6);
  await click("Refresh billing");
  expect(reads).toBe(1);
  expect(host.textContent).not.toContain("520,000");
});
for (const example of BILLING_EXAMPLES)
  test(`${example} renders without requests or sample fallback`, async () => {
    fixture = makeBillingFixture(example);
    await render();
    expect(host.querySelector("h1")!.textContent).toBe("Billing");
    expect(host.textContent).not.toMatch(/NaN|Invalid Date|undefined/);
    if (["loading", "missing", "self-hosted"].includes(example)) {
      expect(host.querySelector("table")).toBeNull();
      expect(host.textContent).not.toContain("€85.00");
    }
  });
test("fixture/live mixing and preview without a fixture fail closed without requests", async () => {
  await render({ mode: "live" });
  expect(host.textContent).toContain("unavailable in this view");
  await React.act(async () => root.render(<Workspace shell={shell()} />));
  expect(host.textContent).toContain("unavailable in this view");
  expect(host.querySelector("table")).toBeNull();
});
test("restricted accounts never imply a reset restores service; missing session usage is never zero", async () => {
  fixture = makeBillingFixture("restricted");
  await render();
  expect(host.textContent).toContain("account is suspended");
  expect(host.textContent).toContain("support@example.test");
  expect(host.querySelectorAll('[role="meter"]')).toHaveLength(0);
  expect(host.textContent).not.toContain("Resets");
  fixture = makeBillingFixture("degraded");
  await render();
  expect(host.textContent).toContain("Showing the last available details");
  expect(host.textContent).toContain("unavailable");
  expect(host.querySelectorAll('[role="meter"]')).toHaveLength(1);
  expect(host.textContent).not.toContain("0%");
});
test("history expansion and focused control survive every shell combination", async () => {
  fixture = makeBillingFixture("long-history");
  await render();
  expect(host.querySelectorAll("tbody tr")).toHaveLength(12);
  await click("Show all 18 payments");
  const node = button("Show recent payments");
  node.focus();
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        await render({ theme, sidebar, chatOpen });
        expect(host.querySelectorAll("tbody tr")).toHaveLength(18);
        expect(button("Show recent payments")).toBe(node);
        expect(document.activeElement).toBe(node);
      }
  await click("Show recent payments");
  expect(host.querySelectorAll("tbody tr")).toHaveLength(12);
});
test("blocked and throwing external openers show recovery, without claiming cancellation", async () => {
  fixture.open = () => false;
  await render();
  await click("Cancel subscription");
  expect(host.textContent).toContain("Allow pop-ups and try the action again");
  expect(host.textContent).not.toContain("subscription is canceled");
  fixture.open = () => {
    throw Error("blocked");
  };
  await render();
  await click("Cancel subscription");
  expect(host.textContent).toContain("Allow pop-ups");
  fixture.open = () => true;
  await render();
  await click("Cancel subscription");
  expect(host.textContent).not.toContain("Allow pop-ups");
});
test("malformed summaries and unsafe receipt links are unavailable", async () => {
  fixture.billing.summary = { plans: [] } as any;
  await render();
  expect(host.textContent).toContain("Billing is unavailable");
  expect(host.querySelector("table")).toBeNull();
  fixture = makeBillingFixture();
  fixture.billing.summary!.payments[0]!.invoiceUrl = "javascript:alert(1)";
  fixture.billing.summary!.payments[0]!.invoicePdfUrl =
    "http://example.test/invoice";
  fixture.billing.links!.cancel = "javascript:alert(1)";
  await render();
  expect(host.querySelector("tbody tr")!.textContent).toContain("Unavailable");
  expect(host.textContent).not.toContain("Cancel subscription");
});
test("live room shares the canonical billing store, reads only GET and refreshes on return; desktop handoff is accepted", async () => {
  const requests: string[] = [];
  let failure = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = String(input);
    requests.push(url);
    if (failure) return new Response("Unavailable", { status: 502 });
    return Response.json(
      url.startsWith("/api/billing")
        ? {
            ok: true,
            summary: fixture.billing.summary,
            links: fixture.billing.links,
          }
        : { ok: true, meter: fixture.budget.meter },
    );
  }) as typeof fetch;
  function SharedConsumer() {
    const value = useBilling({ refreshOnMount: false });
    return (
      <output>
        {value.stale ? "Shared stale bill" : value.summary?.plans[0]?.name}
      </output>
    );
  }
  await React.act(async () =>
    root.render(
      <>
        <SharedConsumer />
        <Workspace shell={shell({ mode: "live" })} />
      </>,
    ),
  );
  expect(requests.filter((url) => url.startsWith("/api/billing"))).toHaveLength(
    1,
  );
  expect(requests.filter((url) => url === "/api/llm/budget")).toHaveLength(1);
  expect(host.textContent).toContain("€85.00");
  expect(host.textContent).not.toContain("Illustrative data");
  const external: string[] = [];
  window.open = ((url: string) => {
    external.push(url);
    return null;
  }) as typeof window.open;
  await click("Cancel subscription");
  expect(host.textContent).toContain("Allow pop-ups");
  window.__jarvisOpensExternally = true;
  await click("Cancel subscription");
  expect(host.textContent).not.toContain("Allow pop-ups");
  expect(external).toEqual([BILLING_LINKS.cancel, BILLING_LINKS.cancel]);
  failure = true;
  await click("Refresh billing");
  expect(host.textContent).toContain("Shared stale bill");
  expect(host.textContent).toContain("Showing the last available details");
  expect(host.textContent).toContain("€85.00");
  failure = false;
  await React.act(async () => window.dispatchEvent(new Event("focus")));
  expect(requests.at(-1)).toBe("/api/billing?fresh=1");
  expect(host.textContent).not.toContain("Showing the last available details");
  expect(
    requests.every(
      (url) => url.startsWith("/api/billing") || url === "/api/llm/budget",
    ),
  ).toBe(true);
});

test("a new payment does not remount the focused invoice action", async () => {
  await render();
  const pdf = button("PDF");
  pdf.focus();
  fixture.billing.summary!.payments.unshift({
    ...fixture.billing.summary!.payments[0]!,
    id: "new-payment",
    invoiceNumber: "NEW",
    paidAt: "2026-10-14T12:00:00Z",
  });
  await render();
  expect(document.activeElement).toBe(pdf);
  expect(pdf.getAttribute("aria-label")).toContain("PREVIEW-1");
  expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
});

test("trial, grace and scheduled cancellation keep their distinct labels and canonical actions", async () => {
  fixture = makeBillingFixture("trial");
  await render();
  expect(host.textContent).toContain("Trial ends");
  expect(host.querySelector(".brief-billing-chip")!.textContent).toBe("Trial");
  expect(button("Cancel subscription")).toBeDefined();
  fixture = makeBillingFixture("grace");
  await render();
  expect(host.textContent).toContain("Past due");
  expect(host.textContent).toContain("stays online until");
  expect(button("Update card")).toBeDefined();
  fixture = makeBillingFixture("canceling");
  await render();
  expect(host.textContent).toContain("Canceling");
  expect(button("Resume subscription")).toBeDefined();
  expect(host.textContent).not.toContain("Cancel subscription");
});
