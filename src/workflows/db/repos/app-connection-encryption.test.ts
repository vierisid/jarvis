import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../index";
import {
  decryptBoundJson, encryptJson, isEncrypted, isRowBound, setEncryptionKey,
  setRequireEncryptedCredentials,
} from "../encryption";
import {
  getConnection, getConnectionByExternalId, getUniqueConnectionByExternalId, listConnections,
  upsertConnection, type UpsertConnectionInput,
} from "./app-connection";
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
  setRequireEncryptedCredentials(false);
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

function setRaw(id: string, value: string): void {
  getWorkflowDb().run("UPDATE app_connection SET value = ? WHERE id = ?", [value, id]);
}

/** Decrypt a raw column the way every read path does: under its own row. */
function readRaw(id: string): unknown {
  const row = getWorkflowDb().query<
    { id: string; project_id: string; piece_name: string; external_id: string; value: string }, [string]
  >("SELECT id, project_id, piece_name, external_id, value FROM app_connection WHERE id = ?").get(id)!;
  return decryptBoundJson(row.value, {
    id: row.id, projectId: row.project_id, pieceName: row.piece_name, externalId: row.external_id,
  });
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
    expect(isRowBound(raw(created.id))).toBe(true);
    expect(readRaw(created.id)).toEqual({ secret: TOKEN });
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

const HIGH = "synthetic-high-privilege-credential-token";
const LOW = "synthetic-low-privilege-credential-token";

/** Two connections owned by different pieces, the #481 attacker's material. */
function twoConnections() {
  const high = upsertConnection({ externalId: "high-privilege-conn", displayName: "High",
    type: "SECRET_TEXT", pieceName: "fixture-admin-piece", pieceVersion: "1.0.0", value: { secret: HIGH } });
  const low = upsertConnection({ externalId: "low-privilege-conn", displayName: "Low",
    type: "SECRET_TEXT", pieceName: "fixture-guest-piece", pieceVersion: "1.0.0", value: { secret: LOW } });
  return { high, low };
}

describe("credential ciphertext is bound to its row", () => {
  test("pasting one row's value column into another makes the read fail, not impersonate", () => {
    const { high, low } = twoConnections();
    // The attacker has write access to the database and no key at all.
    setRaw(low.id, raw(high.id));
    for (const read of [
      () => getConnection(low.id),
      () => getConnectionByExternalId("jrv_proj_default", "fixture-guest-piece", "low-privilege-conn"),
      () => getUniqueConnectionByExternalId("jrv_proj_default", "low-privilege-conn"),
      () => listConnections("jrv_proj_default", "fixture-guest-piece"),
    ]) {
      let result: string | null = null;
      let message = "";
      try { result = JSON.stringify(read()); } catch (error) { message = (error as Error).message; }
      // Before the binding every one of these returned the high-privilege
      // credential and authenticated cleanly.
      expect(result).toBeNull();
      expect(message).toContain("auth verification failed");
      expect(message).not.toContain(HIGH);
      expect(message).not.toContain(LOW);
    }
    // The donor row is untouched and still reads.
    expect(getConnection(high.id)?.value).toEqual({ secret: HIGH });
  });

  test.each([
    ["piece_name", "fixture-guest-piece"],
    ["external_id", "low-privilege-conn-clone"],
    ["project_id", "jrv_proj_other"],
    ["id", "conn_relabelled_fixture"],
  ] as const)("relabelling a row's %s breaks its own ciphertext", (column, replacement) => {
    const { high } = twoConnections();
    // Rearranging identity instead of ciphertext: hand the high-privilege
    // row the labels the low-privilege piece looks up.
    getWorkflowDb().run(`UPDATE app_connection SET ${column} = ? WHERE id = ?`, [replacement, high.id]);
    const id = column === "id" ? replacement : high.id;
    expect(() => getConnection(id)).toThrow(/auth verification failed/);
  });

  test("columns that legitimately change are not bound", () => {
    const { high } = twoConnections();
    getWorkflowDb().run(
      "UPDATE app_connection SET display_name = ?, piece_version = ?, status = ?, owner_id = ? WHERE id = ?",
      ["Renamed", "9.9.9", "ERROR", "someone-else", high.id],
    );
    expect(getConnection(high.id)?.value).toEqual({ secret: HIGH });
    // A re-upsert under the same lookup tuple keeps reading, so the binding
    // costs nothing during normal operation.
    const again = upsertConnection({ externalId: "high-privilege-conn", displayName: "High",
      type: "SECRET_TEXT", pieceName: "fixture-admin-piece", pieceVersion: "2.0.0", value: { secret: LOW } });
    expect(again.id).toBe(high.id);
    expect(getConnectionByExternalId("jrv_proj_default", "fixture-admin-piece", "high-privilege-conn")?.value)
      .toEqual({ secret: LOW });
  });

  test("a mixed table of plaintext, enc1: and enc1a: rows all read", () => {
    const { high, low } = twoConnections();
    const legacy = upsertConnection({ externalId: "legacy-conn", displayName: "Legacy",
      type: "SECRET_TEXT", pieceName: "fixture-legacy-piece", pieceVersion: "1.0.0", value: { secret: LOW } });
    setRaw(legacy.id, JSON.stringify({ secret: "synthetic-legacy-plaintext-token" }));
    setRaw(low.id, encryptJson({ secret: "synthetic-unbound-envelope-token" }));
    expect([isEncrypted(raw(legacy.id)), isRowBound(raw(low.id)), isRowBound(raw(high.id))])
      .toEqual([false, false, true]);
    // Ordered by piece_name: admin (enc1a:), guest (enc1:), legacy (plaintext).
    expect(listConnections("jrv_proj_default").map(c => c.value)).toEqual([
      { secret: HIGH },
      { secret: "synthetic-unbound-envelope-token" },
      { secret: "synthetic-legacy-plaintext-token" },
    ]);
  });

  test("strict mode refuses the plaintext row and keeps reading the un-converted enc1: row", () => {
    const { high, low } = twoConnections();
    setRaw(low.id, encryptJson({ secret: "synthetic-unbound-envelope-token" }));
    const legacy = upsertConnection({ externalId: "legacy-conn", displayName: "Legacy",
      type: "SECRET_TEXT", pieceName: "fixture-legacy-piece", pieceVersion: "1.0.0", value: { secret: LOW } });
    setRaw(legacy.id, JSON.stringify({ secret: "synthetic-legacy-plaintext-token" }));
    setRequireEncryptedCredentials(true);
    expect(() => getConnection(legacy.id)).toThrow(/plaintext credential refused/);
    expect(getConnection(low.id)?.value).toEqual({ secret: "synthetic-unbound-envelope-token" });
    expect(getConnection(high.id)?.value).toEqual({ secret: HIGH });
  });

  test("strict mode refuses a ciphertext swapped for attacker plaintext", () => {
    const { high } = twoConnections();
    setRequireEncryptedCredentials(true);
    setRaw(high.id, JSON.stringify({ secret: "synthetic-attacker-supplied-token" }));
    expect(() => getConnection(high.id)).toThrow(/plaintext credential refused/);
  });
});
