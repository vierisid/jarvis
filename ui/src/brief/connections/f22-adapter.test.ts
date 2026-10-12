import { expect, test, describe } from "bun:test";
import {
  createF22ConnectionsPort,
  projectF22,
  type F22Snapshot,
  type F22Binding,
} from "./f22-adapter";
import { ConnectionsController } from "./controller";
import { connectionKey, connectionStatus } from "./model";

function snapshot(): F22Snapshot {
  return {
    contractVersion: 1,
    scopeId: "fixture",
    asOf: 100,
    sources: {
      devices: "ready",
      google: "unavailable",
      channels: "ready",
      pieces: "ready",
      accounts: "ready",
    },
    rows: [
      {
        sourceId: "piece:notes",
        kind: "library_piece",
        serviceId: "notes",
        label: "Notes",
        status: "installed",
        evidence: "loaded_piece",
        pieceVersion: "1.0.0",
        setupActionId: "setup:notes",
        accountId: null,
        authenticated: null,
        availability: "ready",
        permissions: { canInspect: true, canConnect: true, canRevoke: false },
      },
      {
        sourceId: "account:one",
        kind: "workflow_connection",
        serviceId: "notes",
        label: "Studio workspace",
        status: "configured",
        evidence: "saved_credentials",
        pieceVersion: "1.0.0",
        setupActionId: "setup:notes",
        accountId: "one",
        authenticated: null,
        availability: "unknown",
        permissions: { canInspect: true, canConnect: true, canRevoke: true },
      },
      {
        sourceId: "device:one",
        kind: "device",
        serviceId: "sidecar",
        label: "Studio laptop",
        status: "disconnected",
        evidence: "none",
        pieceVersion: null,
        setupActionId: null,
        accountId: "one",
        authenticated: false,
        availability: "unavailable",
        permissions: { canInspect: true, canConnect: false, canRevoke: true },
      },
    ],
    setup: [
      {
        id: "setup:notes",
        label: "Notes",
        target: {
          kind: "piece_credentials",
          pieceName: "notes",
          pieceVersion: "1.0.0",
          authType: "OAUTH2",
        },
        verifies: { kind: "workflow_connection", serviceId: "notes" },
      },
    ],
  };
}
test("F22 projection preserves configured, installed, offline and partial sources separately", () => {
  const data = projectF22(snapshot(), "fixture")!;
  expect(data.unavailableSources).toEqual(["google"]);
  expect(data.catalog[0]!.setup).toBe("settings"); // OAuth-shaped piece credentials still use the existing manual form.
  expect(data.connections.map((r) => connectionStatus(r).text)).toEqual([
    "Available in library",
    "Configured · not verified",
    "Offline",
  ]);
  expect(data.connections[1]!.name).toBe("Notes");
  expect(data.connections[1]!.accountLabel).toBe("Studio workspace");
  expect(data.connections[2]!.device?.canUpdate).toBe(false);
});
test("F22 rejects foreign, invalid, and duplicate snapshots instead of treating them as empty", () => {
  expect(projectF22(snapshot(), "other")).toBeNull();
  const s = snapshot();
  s.rows.push(s.rows[0]!);
  expect(projectF22(s, "fixture")).toBeNull();
  expect(
    projectF22({ ...snapshot(), sources: {} } as any, "fixture"),
  ).toBeNull();
  expect(
    projectF22({ ...snapshot(), contractVersion: 2 } as any, "fixture"),
  ).toBeNull();
});
test("F22 projection only retains public presentation fields", () => {
  const s = snapshot();
  (s.rows[1] as any).value = "secret-must-not-render";
  expect(JSON.stringify(projectF22(s, "fixture"))).not.toContain(
    "secret-must-not-render",
  );
});
test("missing F22 remains unsupported without importing an unmerged provider", async () => {
  expect(
    await createF22ConnectionsPort("fixture").read(
      new AbortController().signal,
    ),
  ).toEqual({ state: "unsupported" });
});

// Run against the pinned F-22 export without making this D branch depend on an unmerged module.
// See D-27.md for extraction/command. No live service, credential write or OAuth is involved.
const modulePath = process.env.D27_F22_SETUP_MODULE;
const ConnectionSetup = modulePath
  ? (await import(modulePath)).ConnectionSetup
  : null;
describe.skipIf(!modulePath)("real F22 headless adapter integration", () => {
  function fixture() {
    let data = snapshot(),
      available = true,
      launches = 0;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const binding: F22Binding = {
      storage,
      read: async () =>
        available
          ? { status: "ready", data: structuredClone(data) }
          : { status: "unavailable", code: "fixture" },
      createSetup: (scope, ports) => new ConnectionSetup(scope, ports),
      openSetup: () => {
        launches++;
      },
      manageDevice: async () => ({ state: "opened" }),
      addDevice: async () => ({ state: "opened" }),
    };
    return {
      binding,
      port: createF22ConnectionsPort("fixture", binding),
      data,
      values,
      launches: () => launches,
      unavailable: () => {
        available = false;
      },
    };
  }
  const signal = () => new AbortController().signal;
  const command = {
    attemptId: "attempt-one",
    serviceId: "setup:notes",
    reconnectKey: null,
    position: { search: "notes", anchorId: "setup:notes", scrollTop: 120 },
  };
  async function idle(c: ConnectionsController) {
    for (let i = 0; i < 100 && c.snapshot().busy; i++)
      await new Promise((r) => setTimeout(r, 1));
    expect(c.snapshot().busy).toBe(false);
  }
  test("persists before opening; reload restores search/scroll and never relaunches", async () => {
    const f = fixture();
    expect((await f.port.start(command, signal())).state).toBe("pending");
    expect(f.launches()).toBe(1);
    expect(f.values.size).toBe(1);
    const c = new ConnectionsController(
      createF22ConnectionsPort("fixture", f.binding),
    );
    c.setAccess(true);
    await idle(c);
    expect(c.snapshot().setupState).toBe("pending");
    expect(c.snapshot().search).toBe("notes");
    expect(c.scrollPositions.get("catalog")).toBe(120);
    expect(f.launches()).toBe(1);
    c.retire();
  });
  test("requires explicit exact account selection and reports configured without connected", async () => {
    const f = fixture(),
      c = new ConnectionsController(f.port, () => "attempt-one");
    c.setAccess(true);
    await idle(c);
    c.catalog();
    c.select("setup:notes");
    await c.start();
    await c.check();
    expect(c.snapshot().setupState).toBe("pending");
    expect(c.snapshot().candidateKeys).toEqual([
      connectionKey(f.data.rows[1]!),
    ]);
    c.selectAccount(connectionKey(f.data.rows[1]!));
    await c.check();
    expect(c.snapshot().setupState).toBe("configured");
    expect(c.snapshot().message).toContain(
      "Authentication has not been verified",
    );
    c.back();
    c.catalog();
    c.select("setup:notes");
    await c.start();
    expect(f.launches()).toBe(2); // A new explicit action after completion is allowed.
    c.retire();
  });
  test("only a fresh exact account with authenticated connected evidence confirms", async () => {
    const f = fixture();
    await f.port.start(command, signal());
    const row = f.data.rows[1]!;
    row.status = "connected";
    row.authenticated = true;
    row.availability = "ready";
    expect(
      (await f.port.check("foreign-attempt", signal(), connectionKey(row)))
        .state,
    ).toBe("error");
    expect((await f.port.check(command.attemptId, signal())).state).toBe(
      "pending",
    );
    expect(
      await f.port.check(command.attemptId, signal(), connectionKey(row)),
    ).toMatchObject({ state: "confirmed", connectionKey: connectionKey(row) });
  });
  test("cancel survives reload and blocks stale checks and reopening", async () => {
    const f = fixture();
    await f.port.start(command, signal());
    expect((await f.port.cancel(command.attemptId, signal())).state).toBe(
      "cancelled",
    );
    const port = createF22ConnectionsPort("fixture", f.binding);
    expect((await port.resume(signal())).state).toBe("cancelled");
    expect((await port.check(command.attemptId, signal())).state).toBe(
      "cancelled",
    );
    expect(f.launches()).toBe(1);
  });
  test("expiry survives reload and requires a fresh explicit attempt", async () => {
    const f = fixture();
    await f.port.start(command, signal());
    for (const [key, raw] of f.values)
      f.values.set(
        key,
        JSON.stringify({ ...JSON.parse(raw), expiresAt: Date.now() - 10 }),
      );
    const port = createF22ConnectionsPort("fixture", f.binding);
    expect((await port.resume(signal())).state).toBe("expired");
    expect(f.launches()).toBe(1);
    expect(
      (await port.start({ ...command, attemptId: "fresh" }, signal())).state,
    ).toBe("pending");
    expect(f.launches()).toBe(2);
  });
  test("lost start response recovers the same persisted attempt without replay", async () => {
    const f = fixture();
    const original = f.port.start;
    f.port.start = async (...args) => {
      await original(...args);
      throw Error("response lost");
    };
    const c = new ConnectionsController(f.port, () => command.attemptId);
    c.setAccess(true);
    await idle(c);
    c.select(command.serviceId);
    await c.start();
    expect(c.snapshot().setupState).toBe("unknown");
    await c.check();
    expect(c.snapshot().setupState).toBe("pending");
    expect(f.launches()).toBe(1);
    c.retire();
  });
  test("storage failure refuses external launch and unavailable reads purge accounts", async () => {
    const f = fixture();
    f.binding.storage.setItem = () => {
      throw Error("storage unavailable");
    };
    const port = createF22ConnectionsPort("fixture", f.binding);
    expect((await port.start(command, signal())).state).toBe("cancelled");
    expect(f.launches()).toBe(0);
    f.unavailable();
    expect(await port.read(signal())).toEqual({ state: "unavailable" });
  });
  test("revoked setup permission refuses launch without leaving an uncertain attempt", async () => {
    const f = fixture();
    const row = f.data.rows[1]!;
    row.permissions.canConnect = false;
    expect(
      (
        await f.port.start(
          { ...command, reconnectKey: connectionKey(row) },
          signal(),
        )
      ).state,
    ).toBe("cancelled");
    expect(f.launches()).toBe(0);
  });
  test("reconnect cannot confirm a different account", async () => {
    const f = fixture(),
      target = f.data.rows[1]!;
    const other = {
      ...target,
      sourceId: "account:two",
      accountId: "two",
      status: "connected" as const,
      authenticated: true,
      availability: "ready" as const,
    };
    f.data.rows.push(other);
    await f.port.start(
      { ...command, reconnectKey: connectionKey(target) },
      signal(),
    );
    expect(
      (await f.port.check(command.attemptId, signal(), connectionKey(other)))
        .state,
    ).toBe("configured");
    expect(
      (
        (await f.port.check(
          command.attemptId,
          signal(),
          connectionKey(other),
        )) as any
      ).connectionKey,
    ).toBe(connectionKey(target));
  });
});
