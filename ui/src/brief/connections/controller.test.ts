import { expect, test } from "bun:test";
import { ConnectionsController } from "./controller";
import { makeConnectionsFixture, type ConnectionExample } from "./fixtures";
import {
  connectionKey,
  connectionStatus,
  readWorkspace,
  unavailableConnectionsPort,
  type SetupRead,
  type WorkspaceRead,
} from "./model";
function idle(c: ConnectionsController) {
  if (!c.snapshot().busy) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(Error("Controller did not settle"));
    }, 2000);
    const unsubscribe = c.subscribe(() => {
      if (!c.snapshot().busy) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}
async function fixture(example: ConnectionExample = "ready") {
  const f = makeConnectionsFixture(example);
  f.controller.setAccess(true);
  await idle(f.controller);
  return f;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("missing provider is explicitly unsupported without a fabricated account", async () => {
  const c = new ConnectionsController(unavailableConnectionsPort("scope"));
  c.setAccess(true);
  await idle(c);
  expect(c.snapshot().read.state).toBe("unsupported");
  c.catalog();
  await c.start();
  expect(c.snapshot().service).toBeNull();
});
test("identity includes namespace and account, while display text never decides connectivity", () => {
  const f = makeConnectionsFixture(),
    row = f.data.connections[2]!;
  expect(connectionKey(row.identity)).not.toBe(
    connectionKey({ ...row.identity, accountId: "another-account" }),
  );
  expect(connectionKey(row.identity)).not.toBe(
    connectionKey({ ...row.identity, kind: "workflow_connection" }),
  );
  expect(
    connectionStatus({
      ...row,
      identity: { ...row.identity, kind: "library_piece" },
    }).text,
  ).toBe("Available in library");
  expect(
    connectionStatus({
      ...row,
      identity: { ...row.identity, authenticated: null },
    }).text,
  ).toBe("Not verified");
  expect(connectionStatus(row, true).text).toBe("Status needs refresh");
  expect(connectionStatus(f.data.connections[1]!).text).toBe("Offline");
});
test("projection rejects malformed and duplicate identities and strips unmodeled secrets", () => {
  const f = makeConnectionsFixture();
  (f.data.connections[0] as any).token = "must-not-cross";
  (f.data.connections[0]!.identity as any).credentials = {
    token: "must-not-cross",
  };
  expect(JSON.stringify(readWorkspace(f.data))).not.toContain("must-not-cross");
  const duplicate = structuredClone(f.data);
  duplicate.connections.push(duplicate.connections[0]!);
  expect(readWorkspace(duplicate)).toBeNull();
  const malformed = structuredClone(f.data);
  (malformed.connections[0]!.identity.permissions as any).canConnect = "yes";
  expect(readWorkspace(malformed)).toBeNull();
});
test("launch and unverified return keep account status unchanged and never duplicate start", async () => {
  const f = await fixture(),
    c = f.controller;
  c.catalog();
  c.select("gmail");
  await c.start();
  await c.start();
  await c.handoff();
  await c.check();
  expect(c.snapshot().setupState).toBe("pending");
  expect(f.starts()).toBe(1);
  expect(f.handoffs).toEqual(["gmail"]);
  expect(f.data.connections).toHaveLength(5);
  expect(c.snapshot().service?.name).toBe("Gmail");
  expect(c.snapshot().service?.icon).toBe("mail");
});
test("confirmed callback waits for a fresh canonical account before publishing any success", async () => {
  const f = await fixture(),
    c = f.controller;
  c.select("gmail");
  await c.start();
  f.confirm();
  const slow = deferred<WorkspaceRead>();
  f.port.read = () => slow.promise;
  const seen: string[] = [];
  const unsubscribe = c.subscribe(() => seen.push(c.snapshot().setupState));
  const pending = c.check();
  await new Promise((r) => setTimeout(r, 5));
  expect(seen).not.toContain("confirmed");
  expect(c.snapshot().setupState).toBe("pending");
  slow.resolve({ state: "ready", data: structuredClone(f.data) });
  await pending;
  unsubscribe();
  expect(c.snapshot().setupState).toBe("confirmed");
  expect(c.snapshot().message).toContain("preview.account.1@northwind.example");
  c.back();
  expect(c.snapshot().panel).toBe("workspace");
});
for (const problem of [
  "missing",
  "wrong-service",
  "unverified",
  "unavailable-account",
  "stale",
  "wrong-reconnect-account",
] as const) {
  test(`confirmation rejects ${problem} projection`, async () => {
    const f = await fixture(),
      c = f.controller;
    const reconnect =
      problem === "wrong-reconnect-account"
        ? connectionKey(f.data.connections[4]!.identity)
        : null;
    c.select(reconnect ? "notion" : "gmail", reconnect);
    await c.start();
    f.confirm();
    const read = structuredClone(f.data),
      account = read.connections.at(-1)!;
    if (problem === "missing") read.connections.pop();
    if (problem === "wrong-service") account.setupServiceId = "calendar";
    if (problem === "unverified") account.identity.authenticated = false;
    if (problem === "unavailable-account")
      account.identity.availability = "unavailable";
    if (problem === "wrong-reconnect-account") {
      const check = f.port.check;
      f.port.check = async (...args) => {
        const result = await check(...args);
        return result.state === "confirmed"
          ? {
              ...result,
              connectionKey: connectionKey(read.connections[2]!.identity),
            }
          : result;
      };
    }
    f.port.read = async () => ({
      state: problem === "stale" ? "stale" : "ready",
      data: read,
    });
    await c.check();
    expect(c.snapshot().setupState).toBe("unknown");
    await c.start();
    expect(f.starts()).toBe(1);
  });
}
test("reconnect confirms only the selected account and leaves sibling accounts alone", async () => {
  const f = await fixture(),
    c = f.controller;
  const row = f.data.connections[4]!,
    sibling = structuredClone(row);
  sibling.identity.accountId = "Other workspace";
  f.data.connections.push(sibling);
  await c.refresh();
  c.select("notion", connectionKey(row.identity));
  await c.start();
  f.confirm();
  await c.check();
  expect(c.snapshot().setupState).toBe("confirmed");
  expect(row.identity.authenticated).toBe(true);
  expect(sibling.identity.authenticated).toBe(false);
});
test("mismatched setup identity never replaces selected service or becomes connected", async () => {
  const f = await fixture(),
    c = f.controller;
  c.select("gmail");
  await c.start();
  f.port.check = async () => ({
    state: "confirmed",
    ticket: { ...c.snapshot().ticket!, serviceId: "calendar" },
    connectionKey: connectionKey(f.data.connections[3]!.identity),
  });
  await c.check();
  expect(c.snapshot().setupState).toBe("unknown");
  expect(c.snapshot().service?.id).toBe("gmail");
});
test("a confirmation cannot drop the reconnect identity even when the account is connected", async () => {
  const f = await fixture(),
    c = f.controller;
  const row = f.data.connections[4]!;
  c.select("notion", connectionKey(row.identity));
  await c.start();
  f.confirm();
  f.port.check = async () => ({
    state: "confirmed",
    ticket: { ...c.snapshot().ticket!, reconnectKey: null },
    connectionKey: connectionKey(row.identity),
  });
  await c.check();
  expect(c.snapshot().setupState).toBe("unknown");
  expect(c.snapshot().reconnectKey).toBe(connectionKey(row.identity));
});
test("cancel preserves catalog search and accounts and permits deliberate retry", async () => {
  const f = await fixture(),
    c = f.controller;
  c.catalog();
  c.setSearch("gmail");
  c.select("gmail");
  await c.start();
  await c.cancel();
  f.confirm();
  expect(f.data.connections).toHaveLength(5);
  expect(c.snapshot().setupState).toBe("cancelled");
  c.back();
  expect(c.snapshot().panel).toBe("catalog");
  expect(c.snapshot().search).toBe("gmail");
  expect(f.cancels()).toBe(1);
});
test("expired setup requires a new attempt and never reports connection success", async () => {
  const f = await fixture("expired"),
    c = f.controller;
  c.select("gmail");
  await c.start();
  const first = c.snapshot().attemptId;
  await c.check();
  expect(c.snapshot().setupState).toBe("expired");
  await c.start();
  expect(c.snapshot().attemptId).not.toBe(first);
  expect(f.starts()).toBe(2);
});
test("lost start response recovers the same backend attempt rather than replaying", async () => {
  const f = await fixture("lost-start"),
    c = f.controller;
  c.select("gmail");
  await c.start();
  const first = c.snapshot().attemptId;
  expect(c.snapshot().setupState).toBe("unknown");
  await c.start();
  await c.check();
  expect(c.snapshot().attemptId).toBe(first);
  expect(c.snapshot().setupState).toBe("pending");
  expect(f.starts()).toBe(1);
});
test("lost cancellation is unknown until a status read recovers cancellation", async () => {
  const f = await fixture("lost-cancel"),
    c = f.controller;
  c.select("gmail");
  await c.start();
  await c.cancel();
  expect(c.snapshot().setupState).toBe("unknown");
  await c.start();
  await c.check();
  expect(c.snapshot().setupState).toBe("cancelled");
  expect(f.starts()).toBe(1);
  expect(f.cancels()).toBe(1);
});
test("a fresh controller resumes the backend attempt after reload without browser success parameters", async () => {
  const f = await fixture(),
    c = f.controller;
  c.select("gmail");
  await c.start();
  const id = c.snapshot().attemptId;
  c.retire();
  const next = new ConnectionsController(f.port);
  next.setAccess(true);
  await idle(next);
  expect(next.snapshot().panel).toBe("setup");
  expect(next.snapshot().service?.id).toBe("gmail");
  expect(next.snapshot().attemptId).toBe(id);
  expect(next.snapshot().setupState).toBe("pending");
  expect(f.starts()).toBe(1);
});
test("failed resume prevents new setup until a backend read says no attempt exists", async () => {
  const f = makeConnectionsFixture();
  f.port.resume = async () => ({ state: "error" });
  f.controller.setAccess(true);
  await idle(f.controller);
  f.controller.catalog();
  f.controller.select("gmail");
  await f.controller.start();
  expect(f.starts()).toBe(0);
  f.port.resume = async () => ({ state: "none" });
  await f.controller.refresh(true);
  f.controller.select("gmail");
  await f.controller.start();
  expect(f.starts()).toBe(1);
});
test("scope access loss clears account data and ignores late setup confirmation", async () => {
  const f = await fixture(),
    c = f.controller;
  c.select("gmail");
  await c.start();
  const slow = deferred<SetupRead>(),
    ticket = c.snapshot().ticket!;
  f.port.check = () => slow.promise;
  const pending = c.check();
  c.setAccess(false);
  slow.resolve({
    state: "confirmed",
    ticket,
    connectionKey: connectionKey(f.data.connections[2]!.identity),
  });
  await pending;
  expect(c.snapshot().read.state).toBe("unavailable");
  expect(c.snapshot().ticket).toBeNull();
  expect(c.snapshot().service).toBeNull();
  expect(JSON.stringify(c.snapshot())).not.toContain("northwind.example");
});
test("backend access denial during verification purges visible cached account data", async () => {
  const f = await fixture(),
    c = f.controller;
  c.select("gmail");
  await c.start();
  f.port.check = async () => ({ state: "unavailable" });
  await c.check();
  expect(c.snapshot().read.state).toBe("unavailable");
  expect(c.snapshot().ticket).toBeNull();
  expect(JSON.stringify(c.snapshot())).not.toContain("northwind.example");
});
test("canceling a pending start ignores its late completion", async () => {
  const f = await fixture(),
    c = f.controller,
    slow = deferred<SetupRead>();
  let ticket!: ReturnType<ConnectionsController["snapshot"]>["ticket"];
  f.port.start = async (command) => {
    ticket = { ...command, expiresAt: Date.now() + 1000 };
    return slow.promise;
  };
  f.port.cancel = async () => ({ state: "cancelled", ticket: ticket! });
  c.select("gmail");
  const start = c.start();
  await c.cancel();
  slow.resolve({ state: "pending", ticket: ticket! });
  await start;
  expect(c.snapshot().setupState).toBe("cancelled");
});
test("device updates, revoke and enrollment hand off exact identity without changing reported status", async () => {
  const f = await fixture(),
    c = f.controller,
    device = f.data.connections[1]!;
  c.device(connectionKey(device.identity));
  await c.manageDevice("update");
  await c.manageDevice("revoke");
  await c.addDevice();
  expect(f.devices).toEqual([
    { key: connectionKey(device.identity), action: "update" },
    { key: connectionKey(device.identity), action: "revoke" },
    { key: "enrollment", action: "add" },
  ]);
  expect(device.identity.availability).toBe("unavailable");
  expect(c.snapshot().read.state).toBe("ready");
});
test("device and reconnect permissions are honored without hiding actual offline status", async () => {
  const f = await fixture("read-only"),
    c = f.controller;
  c.device(connectionKey(f.data.connections[1]!.identity));
  await c.manageDevice("update");
  await c.manageDevice("revoke");
  c.select("notion", connectionKey(f.data.connections[4]!.identity));
  await c.start();
  expect(f.devices).toEqual([]);
  expect(f.starts()).toBe(0);
});
test("stale and missing reads do not become empty success or allow setup", async () => {
  for (const example of ["stale", "unavailable"] as const) {
    const f = await fixture(example);
    f.controller.select("gmail");
    await f.controller.start();
    expect(f.starts()).toBe(0);
    expect(f.controller.snapshot().read.state).toBe(example);
  }
  const f = await fixture("empty");
  const read = f.controller.snapshot().read;
  expect(read.state).toBe("ready");
  if ("data" in read) expect(read.data.connections).toEqual([]);
});
test("blocked handoff can retry and raw provider errors never render", async () => {
  const f = await fixture(),
    c = f.controller;
  c.select("gmail");
  await c.start();
  f.port.handoff = async () => {
    throw Error("secret-token-must-not-render");
  };
  await c.handoff();
  expect(c.snapshot().message).toContain("could not be opened");
  expect(JSON.stringify(c.snapshot())).not.toContain("secret-token");
  expect(c.snapshot().setupState).toBe("pending");
});
test("a fresh permission or catalog change prevents starting a stale selection", async () => {
  const f = await fixture(),
    c = f.controller;
  c.select("notion", connectionKey(f.data.connections[4]!.identity));
  f.data.connections[4]!.identity.permissions.canConnect = false;
  await c.refresh();
  await c.start();
  expect(f.starts()).toBe(0);
  c.back();
  c.select("gmail");
  f.data.catalog = f.data.catalog.filter((s) => s.id !== "gmail");
  await c.refresh();
  await c.start();
  expect(f.starts()).toBe(0);
});
test("repeated cancel shares one in-flight cancellation", async () => {
  const f = await fixture(),
    c = f.controller;
  c.select("gmail");
  await c.start();
  const first = c.cancel();
  await c.cancel();
  await first;
  expect(f.cancels()).toBe(1);
});
for (const action of ["browser", "device"] as const)
  test(`${action} access denial purges cached accounts`, async () => {
    const f = await fixture(),
      c = f.controller;
    if (action === "browser") {
      c.select("gmail");
      await c.start();
      f.port.handoff = async () => ({ state: "unavailable" });
      await c.handoff();
    } else {
      c.device(connectionKey(f.data.connections[0]!.identity));
      f.port.manageDevice = async () => ({ state: "unavailable" });
      await c.manageDevice("inspect");
    }
    expect(c.snapshot().read.state).toBe("unavailable");
    expect(JSON.stringify(c.snapshot())).not.toContain("northwind.example");
  });
