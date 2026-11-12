import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { setEncryptionKey } from "../db/encryption";
import { getConnection, upsertConnection } from "../db/repos/app-connection";
import { createWorkflowRoutes } from "../api/routes";
import { CredentialResolver } from "./adapter";
import type { TokenTransport } from "./pasted-oauth2";

beforeEach(() => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 0x37));
});
afterEach(() => {
  setEncryptionKey(null);
  closeWorkflowDb();
});

const refreshValue = (tokenUrl: string, extra: Record<string, unknown> = {}) => ({
  access_token: "canary-access", refresh_token: "canary-refresh", client_id: "client", client_secret: "canary-secret",
  token_url: tokenUrl, claimed_at: 1_000, expires_in: 3599, ...extra,
});
const save = (value: Record<string, unknown>) => upsertConnection({ externalId: "work-mail", displayName: "Work mail", type: "OAUTH2",
  pieceName: "@activepieces/piece-gmail", pieceVersion: "0.0.0", value });

async function oauth2Of(resolver: CredentialResolver) {
  const routes = createWorkflowRoutes({ credentialResolver: resolver });
  const res = await routes["/api/workflows/connections"]!.GET!(new Request("http://x/api/workflows/connections"));
  const body = (await res.json()) as { connections: Array<{ oauth2?: { refreshable: boolean; refreshProblem?: { kind: string; message: string } } }> };
  expect(JSON.stringify(body)).not.toContain("canary");
  return body.connections[0]!.oauth2!;
}

describe("a row whose refresh can never work does not say it is refreshed", () => {
  test.each(["https://127.0.0.1/token", "https://203.0.113.9/token", "https://[::1]/token"])("a token URL at %s is blocked by the network policy", async (url) => {
    save(refreshValue(url));
    const oauth2 = await oauth2Of(new CredentialResolver());
    expect(oauth2.refreshable).toBe(true);
    expect(oauth2.refreshProblem).toMatchObject({ kind: "blocked" });
  });

  test("the blocked sentence names the connection and the address and says what to do, in Jarvis's words", async () => {
    save(refreshValue("https://127.0.0.1/token?key=canary-query"));
    const { refreshProblem } = await oauth2Of(new CredentialResolver());
    expect(refreshProblem!.message).toBe("The token URL of connection work-mail is at 127.0.0.1, an address this Jarvis never connects to, "
      + "so no refresh can work. Change the connection's token_url, or reconnect.");
  });

  test("a self-hosted install that reaches its private network does not call a private token URL blocked, but still refuses loopback", async () => {
    save(refreshValue("https://10.0.0.5/token"));
    expect((await oauth2Of(new CredentialResolver({ egressPolicy: "private-allowed" }))).refreshProblem).toBeUndefined();
    expect((await oauth2Of(new CredentialResolver())).refreshProblem).toMatchObject({ kind: "blocked" });
    save(refreshValue("https://127.0.0.1/token"));
    expect((await oauth2Of(new CredentialResolver({ egressPolicy: "private-allowed" }))).refreshProblem).toMatchObject({ kind: "blocked" });
  });

  test.each([["refresh_token"], ["client_secret"], ["client_id"]])("a row without %s is Not refreshed, never given a refresh problem", async (field) => {
    const value: Record<string, unknown> = refreshValue("https://127.0.0.1/token");
    delete value[field];
    save(value);
    const oauth2 = await oauth2Of(new CredentialResolver());
    expect(oauth2.refreshable).toBe(false);
    expect(oauth2.refreshProblem).toBeUndefined();
  });

  test("a named host is not guessed at: no problem is claimed before a refresh was tried", async () => {
    save(refreshValue("https://oauth2.example.test/token"));
    expect((await oauth2Of(new CredentialResolver())).refreshProblem).toBeUndefined();
  });

  test("a refresh the provider refused is shown until the value changes", async () => {
    const transport: TokenTransport = async () => ({ status: 400, body: { error: "invalid_grant" } });
    const resolver = new CredentialResolver({ tokenTransport: transport, now: () => 10_000_000 });
    const row = save(refreshValue("https://oauth2.example.test/token"));
    await expect(resolver.fresh({ type: "OAUTH2", value: getConnection(row.id)!.value, pieceName: row.pieceName, status: "ACTIVE",
      stored: { id: row.id, projectId: row.projectId, externalId: row.externalId, generation: 0 } })).rejects.toThrow();
    expect((await oauth2Of(resolver)).refreshProblem).toMatchObject({ kind: "refused", message: expect.stringContaining("refused to refresh") });
    save(refreshValue("https://oauth2.example.test/token", { refresh_token: "canary-refresh-2" }));
    expect((await oauth2Of(resolver)).refreshProblem).toBeUndefined();
  });

  test("a provider's own words never reach the panel: only the status and a well-formed OAuth error code", async () => {
    for (const [error, shown] of [["invalid_grant", "HTTP 401, invalid_grant)"], ["<img src=x onerror=canary>", "HTTP 401)"]] as const) {
      const transport: TokenTransport = async () => ({ status: 401, body: { error, error_description: "canary-provider-text <b>x</b>" } });
      const resolver = new CredentialResolver({ tokenTransport: transport, now: () => 10_000_000 });
      const row = save(refreshValue("https://oauth2.example.test/token", { refresh_token: `canary-${error.length}` }));
      await expect(resolver.fresh({ type: "OAUTH2", value: getConnection(row.id)!.value, pieceName: row.pieceName, status: "ACTIVE",
        stored: { id: row.id, projectId: row.projectId, externalId: row.externalId, generation: getConnection(row.id)!.credentialGeneration } })).rejects.toThrow();
      const { refreshProblem } = await oauth2Of(resolver);
      expect(refreshProblem!.message).toContain(shown);
      expect(refreshProblem!.message).not.toContain("<");
    }
  });

  test("a provider that did not answer is shown as that, not as a refusal", async () => {
    const transport: TokenTransport = async () => { throw new Error("socket hang up"); };
    const resolver = new CredentialResolver({ tokenTransport: transport, now: () => 10_000_000 });
    const row = save(refreshValue("https://oauth2.example.test/token"));
    await expect(resolver.fresh({ type: "OAUTH2", value: getConnection(row.id)!.value, pieceName: row.pieceName, status: "ACTIVE",
      stored: { id: row.id, projectId: row.projectId, externalId: row.externalId, generation: 0 } })).rejects.toThrow();
    expect((await oauth2Of(resolver)).refreshProblem).toMatchObject({ kind: "unreachable" });
  });
});
