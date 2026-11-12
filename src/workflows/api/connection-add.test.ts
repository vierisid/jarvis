import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { setEncryptionKey } from "../db/encryption";
import { getConnection, listConnections, upsertConnection } from "../db/repos/app-connection";
import { PieceCatalog, type PieceCatalogEntry } from "../runtime/piece-catalog";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

let routes: WorkflowRouteMap;
beforeEach(() => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 0x31));
  routes = createWorkflowRoutes();
});
afterEach(() => {
  setEncryptionKey(null);
  closeWorkflowDb();
});

const PIECE = "@activepieces/piece-slack";
const good = { externalId: "slack-main", displayName: "Slack", type: "SECRET_TEXT", pieceName: PIECE, value: { secret_text: "canary-key-one" } };

async function add(body: unknown, withRoutes: WorkflowRouteMap = routes) {
  const req = new Request("http://localhost/api/workflows/connections", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) as Request & { params: Record<string, string> };
  req.params = {};
  const res = await withRoutes["/api/workflows/connections"]!.POST!(req);
  return { status: res.status, body: (await res.json()) as { error?: string; id?: string } };
}

describe("adding a connection never replaces one", () => {
  test("the same external id for the same piece is a 409 that points to Rotate, and the saved secret stays", async () => {
    const first = await add(good);
    expect(first.status).toBe(201);
    const second = await add({ ...good, displayName: "Other name", value: { secret_text: "canary-key-two" } });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("Rotate");
    expect(JSON.stringify(second.body)).not.toContain("canary-key");
    const rows = listConnections();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe("Slack");
    expect(getConnection(first.body.id!)!.value).toEqual({ secret_text: "canary-key-one" });
    expect(getConnection(first.body.id!)!.credentialGeneration).toBe(0);
  });

  test("the same external id for another piece is a separate connection", async () => {
    expect((await add(good)).status).toBe(201);
    expect((await add({ ...good, pieceName: "@activepieces/piece-discord" })).status).toBe(201);
  });
});

describe("a new connection's fields are checked", () => {
  test.each([
    ["a very long name", { displayName: "x".repeat(201) }],
    ["a name with a line break", { displayName: "a\nb" }],
    ["a name with a bidi override", { displayName: "cv\u202Egpj.exe" }],
    ["a name with a line separator", { displayName: "a\u2028b" }],
    ["a blank name", { displayName: "   " }],
    ["a zero-width space in the id", { externalId: "slack\u200Bmain" }],
    ["a NUL in the id", { externalId: "a\u0000b" }],
    ["a long id", { externalId: "i".repeat(201) }],
    ["a reserved id", { externalId: "__proto__" }],
    ["an unknown type", { type: "BOGUS" }],
  ])("%s is a plain 400", async (_label, patch) => {
    const r = await add({ ...good, ...patch });
    expect(r.status).toBe(400);
    expect(r.body.error).toBeTruthy();
    expect(listConnections()).toHaveLength(0);
  });

  test("a piece the install does not know is refused when the catalog is available", async () => {
    const entry = { name: PIECE, displayName: "Slack", description: "", actions: {}, triggers: {} } as unknown as PieceCatalogEntry;
    const withCatalog = createWorkflowRoutes({ pieceRegistry: new PieceCatalog([entry]) });
    const bad = await add({ ...good, pieceName: "not-a-piece" }, withCatalog);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("not-a-piece");
    expect((await add(good, withCatalog)).status).toBe(201);
  });

  test("rows saved with odd values before these rules still load", () => {
    upsertConnection({ externalId: "old\u0000id", displayName: "n".repeat(500), type: "BOGUS" as never, pieceName: "not-a-piece", pieceVersion: "0.0.0", value: { a: 1 } });
    expect(listConnections()).toHaveLength(1);
  });
});
