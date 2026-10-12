import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { BriefShellPort } from "../contracts";
import { BRIEF_CONTRACT_VERSION } from "../../../../src/brief/contracts";
import { CONNECTION_SCOPE, makeConnectionsFixture } from "./fixtures";
import type { ConnectionsBinding } from "./ConnectedWorkspace";
let React: typeof import("react"),
  createRoot: (typeof import("react-dom/client"))["createRoot"],
  Workspace: (typeof import("./ConnectedWorkspace"))["ConnectedWorkspace"];
let host: HTMLDivElement,
  root: Root,
  fixture: ReturnType<typeof makeConnectionsFixture>;
const wait = () => new Promise((resolve) => setTimeout(resolve, 15));
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ ConnectedWorkspace: Workspace } = await import("./ConnectedWorkspace"));
});
beforeEach(() => {
  host = document.createElement("div");
  host.className = "brief-workspace-content";
  document.body.append(host);
  root = createRoot(host);
  fixture = makeConnectionsFixture();
});
afterEach(async () => {
  await React.act(async () => {
    root.unmount();
    fixture.controller.retire();
  });
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
function shell(overrides: Partial<BriefShellPort> = {}): BriefShellPort {
  return {
    mode: "preview",
    route: { room: "connected-workspace", selection: {} },
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
function binding(): ConnectionsBinding {
  return {
    source: "fixture",
    scopeId: CONNECTION_SCOPE,
    controller: fixture.controller,
  };
}
async function render(
  overrides: Partial<BriefShellPort> = {},
  bind: ConnectionsBinding | undefined = binding(),
  key = "room",
) {
  await React.act(async () => {
    root.render(
      <Workspace key={key} shell={shell(overrides)} binding={bind} />,
    );
    await wait();
  });
  await React.act(wait);
}
function visibleText() {
  return [
    ...host.querySelectorAll(
      "h1,h2,h3,p,strong,small,dd,.brief-connection-label span,.brief-connection-status",
    ),
  ]
    .filter((n) => !n.closest("[hidden]"))
    .map((n) => n.textContent)
    .join(" ");
}
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) =>
      !node.closest("[hidden]") &&
      (
        node.getAttribute("aria-label") ??
        node.querySelector(".brief-button__label")?.textContent ??
        node.textContent
      )?.trim() === label,
  );
  if (!result) throw Error(`Missing button ${label}`);
  return result;
}
async function click(label: string) {
  await React.act(async () => {
    button(label).click();
    await wait();
  });
}
async function search(value: string) {
  await React.act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(name: string) {
  await React.act(async () => {
    [
      ...host.querySelectorAll<HTMLButtonElement>(
        ".brief-connections-catalog-row",
      ),
    ]
      .find((n) => n.querySelector("strong")?.textContent === name)!
      .click();
    await wait();
  });
}
test("workspace keeps real device status visible without a brain card, old tabs or offline footer", async () => {
  await render();
  expect(visibleText()).toContain("Travel laptop");
  expect(visibleText()).toContain("Offline");
  expect(visibleText()).toContain("alex@studio.example");
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  expect(visibleText()).not.toMatch(/hosted brain|brain offline/i);
});
test("catalog search, selected identity, scroll and focus survive setup cancellation", async () => {
  await render();
  await click("Connect a service");
  await search("gmail");
  host.scrollTop = 85;
  await choose("Gmail");
  expect(host.querySelector("h1")?.textContent).toBe("Gmail");
  expect(document.activeElement).toBe(host.querySelector("h1"));
  await click("Start setup");
  await click("Continue in browser");
  expect(fixture.handoffs).toEqual(["gmail"]);
  await click("Cancel setup");
  await click("All services");
  expect(
    (host.querySelector('input[type="search"]') as HTMLInputElement).value,
  ).toBe("gmail");
  expect(host.scrollTop).toBe(85);
  expect(document.activeElement?.getAttribute("data-service-id")).toBe("gmail");
});
test("browser focus cannot claim connection success before a verified backend read", async () => {
  await render();
  await click("Connect a service");
  await choose("Gmail");
  await click("Start setup");
  await click("Continue in browser");
  await React.act(async () => {
    window.dispatchEvent(new Event("focus"));
    await wait();
  });
  expect(visibleText()).toContain("Finish connecting your account");
  expect(visibleText()).not.toContain("Connection confirmed");
  await React.act(async () => {
    fixture.confirm();
  });
  await click("Check connection");
  expect(visibleText()).toContain("Connection confirmed");
  expect(visibleText()).toContain(
    "Gmail is connected to preview.account.1@studio.example",
  );
  await click("Done");
  expect(host.querySelector("h1")?.textContent).toBe("Connected workspace");
  expect(visibleText()).toContain("preview.account.1@studio.example");
});
test("pending setup and search survive room remount and all eight shell layouts", async () => {
  await render();
  await click("Connect a service");
  await search("gmail");
  await choose("Gmail");
  await click("Start setup");
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        await render(
          { theme, sidebar, chatOpen },
          binding(),
          `${theme}-${sidebar}-${chatOpen}`,
        );
        expect(visibleText()).toContain("Finish connecting your account");
        expect(fixture.controller.snapshot().service?.id).toBe("gmail");
      }
  expect(fixture.starts()).toBe(1);
  expect(fixture.controller.snapshot().search).toBe("gmail");
});
test("expired setup offers an explicit fresh start and reconnect preserves service identity", async () => {
  fixture.controller.retire();
  fixture = makeConnectionsFixture("expired");
  await render();
  await click("Reconnect");
  expect(host.querySelector("h1")?.textContent).toBe("Notion");
  await click("Start setup");
  await click("Check connection");
  expect(visibleText()).toContain("Setup expired");
  await click("Start again");
  expect(fixture.starts()).toBe(2);
  expect(host.querySelector("h1")?.textContent).toBe("Notion");
});
test("device controls remain reachable and hand off the selected offline device", async () => {
  await render();
  await click("Manage Travel laptop");
  expect(visibleText()).toContain("Offline");
  await click("Update device");
  await click("Revoke access");
  await click("Device settings");
  expect(fixture.devices.map((d) => d.action)).toEqual([
    "update",
    "revoke",
    "inspect",
  ]);
  expect(fixture.devices.every((d) => d.key.includes("preview-laptop"))).toBe(
    true,
  );
  expect(visibleText()).toContain("Refresh here to see verified changes");
});
test("fixture and scope mismatches never leak preview accounts into a live shell", async () => {
  await render({ mode: "live" });
  expect(visibleText()).not.toContain("studio.example");
  expect(visibleText()).toContain("unavailable");
  await render({}, { ...binding(), scopeId: "another-scope" });
  expect(fixture.controller.snapshot().read.state).toBe("loading");
  expect(visibleText()).not.toContain("Travel laptop");
});
test("live adapter needs both connections and navigation compatibility gates", async () => {
  fixture.controller.retire();
  fixture.port.source = "live";
  const { ConnectionsController } = await import("./controller");
  fixture.controller = new ConnectionsController(fixture.port);
  const enabled = {
    supported: true,
    ready: true,
    enabled: true,
    state: "ready",
    reason: null,
  };
  const capabilities = {
    contractVersion: BRIEF_CONTRACT_VERSION,
    capabilities: { connections: enabled },
  };
  const live = {
    controller: fixture.controller,
    source: "live" as const,
    scopeId: CONNECTION_SCOPE,
    capabilities,
  };
  await render({ mode: "live" }, live);
  expect(visibleText()).toContain("unavailable");
  await render(
    { mode: "live" },
    {
      ...live,
      capabilities: {
        ...capabilities,
        capabilities: {
          connections: enabled,
          navigationCompatibility: enabled,
        },
      },
    },
  );
  expect(visibleText()).toContain("Travel laptop");
  await render({ mode: "live" }, live);
  expect(visibleText()).not.toContain("Travel laptop");
  expect(fixture.controller.snapshot().read.state).toBe("unavailable");
});
test("missing and empty providers render distinct states; setup remains disabled for stale data", async () => {
  fixture.controller.retire();
  fixture = makeConnectionsFixture("empty");
  await render();
  expect(visibleText()).toContain("No connected services yet");
  await React.act(async () => fixture.controller.retire());
  fixture = makeConnectionsFixture("stale");
  await render({}, binding(), "stale");
  expect(button("Connect a service").disabled).toBe(true);
  expect(visibleText()).toContain("Status needs refresh");
});

test("saved credentials, explicit account selection and partial-source warnings remain honest", async () => {
  fixture.controller.retire();
  fixture = makeConnectionsFixture("configured");
  fixture.data.unavailableSources = ["google"];
  await render();
  expect(visibleText()).toContain("Configured · not verified");
  expect(visibleText()).toContain(
    "Some sources could not be refreshed: google",
  );
  await click("Connect a service");
  await choose("Notion");
  await click("Start setup");
  await click("Check connection");
  const select = host.querySelector<HTMLSelectElement>(
    'select[aria-label="Account to verify"]',
  )!;
  expect(select.textContent).toContain("Studio workspace");
  await React.act(async () => {
    select.value = select.options[1]!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Check connection");
  expect(visibleText()).toContain("Credentials saved");
  expect(visibleText()).not.toContain("Connection confirmed");
  expect(document.activeElement?.textContent).toBe("Credentials saved");
  await click("Done");
  expect(visibleText()).toContain("Configured · not verified");
});
