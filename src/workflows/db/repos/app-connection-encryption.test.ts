import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../index";
import { decryptJson, isEncrypted, setEncryptionKey } from "../encryption";
import { getConnection, upsertConnection, type UpsertConnectionInput } from "./app-connection";
import { createWorkflowRoutes } from "../../api/routes";

const TOKEN = "synthetic-native-credential-insert-token";
const ROTATED = "synthetic-native-credential-updated-token";
const KEY = Buffer.alloc(32, 7);
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-native-encryption-"));
  dbPath = join(dir, "jarvis.db");
  initWorkflowDb(dbPath);
  setEncryptionKey(KEY);
});

afterEach(() => {
  closeWorkflowDb();
  setEncryptionKey(null);
  rmSync(dir, { recursive: true, force: true });
});

function input(value = { secret: TOKEN }): UpsertConnectionInput {
  return { externalId: "native-fixture", displayName: "Fixture", type: "SECRET_TEXT",
    pieceName: "test-piece", pieceVersion: "1.0.0", value };
}

function raw(id: string): string {
  return getWorkflowDb().query<{ value: string }, [string]>(
    "SELECT value FROM app_connection WHERE id = ?",
  ).get(id)!.value;
}

function assertNoSecretsOnDisk() {
  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name));
    expect(bytes.includes(Buffer.from(TOKEN))).toBe(false);
    expect(bytes.includes(Buffer.from(ROTATED))).toBe(false);
  }
}

describe("native credential storage", () => {
  test("new and updated credentials are encrypted in rows, database pages and WAL", () => {
    const created = upsertConnection(input());
    expect(isEncrypted(raw(created.id))).toBe(true);
    expect(raw(created.id)).not.toContain(TOKEN);
    expect(decryptJson(raw(created.id))).toEqual({ secret: TOKEN });
    assertNoSecretsOnDisk();

    const updated = upsertConnection(input({ secret: ROTATED }));
    expect(updated.id).toBe(created.id);
    expect(isEncrypted(raw(created.id))).toBe(true);
    expect(raw(created.id)).not.toContain(ROTATED);
    expect(updated.value).toEqual({ secret: ROTATED });
    assertNoSecretsOnDisk();
    closeWorkflowDb();
    initWorkflowDb(dbPath);
    expect(getConnection(created.id)?.value).toEqual({ secret: ROTATED });
    assertNoSecretsOnDisk();
  });

  test("legacy rows stay readable and become encrypted when updated", () => {
    const created = upsertConnection(input());
    getWorkflowDb().run("UPDATE app_connection SET value = ? WHERE id = ?", [
      JSON.stringify({ secret: TOKEN }), created.id,
    ]);
    expect(getConnection(created.id)?.value).toEqual({ secret: TOKEN });
    const updated = upsertConnection(input({ secret: ROTATED }));
    expect(isEncrypted(raw(updated.id))).toBe(true);
    expect(updated.value).toEqual({ secret: ROTATED });
  });

  test("a key failure never falls back to plaintext on insert or update", () => {
    const created = upsertConnection(input());
    const before = raw(created.id);
    setEncryptionKey(Buffer.alloc(1));
    expect(() => upsertConnection({ ...input(), externalId: "bad-key-insert" })).toThrow();
    expect(() => upsertConnection(input({ secret: ROTATED }))).toThrow();
    expect(raw(created.id)).toBe(before);
    expect(getWorkflowDb().query("SELECT id FROM app_connection").all()).toHaveLength(1);
  });

  test("POST, repeated POST and PATCH encrypt credentials without returning their values", async () => {
    const routes = createWorkflowRoutes();
    const post = routes["/api/workflows/connections"]!.POST!;
    const request = (method: string, value: unknown) => new Request("http://x/api/workflows/connections", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    });
    const response = await post(request("POST", input()));
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(isEncrypted(raw(body.id))).toBe(true);
    expect(getConnection(body.id)?.value).toEqual({ secret: TOKEN });

    const repeated = await post(request("POST", input({ secret: ROTATED })));
    expect((await repeated.json() as { id: string }).id).toBe(body.id);
    const patch = routes["/api/workflows/connections/:id"]!.PATCH!;
    const patchRequest = Object.assign(request("PATCH", { value: { secret: TOKEN } }), {
      params: { id: body.id },
    });
    const patched = await patch(patchRequest);
    expect(patched.status).toBe(200);
    expect(await patched.text()).not.toContain(TOKEN);
    expect(getConnection(body.id)?.value).toEqual({ secret: TOKEN });
    expect(isEncrypted(raw(body.id))).toBe(true);
    assertNoSecretsOnDisk();
  });
});
