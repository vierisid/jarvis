import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from "../db";
import { setEncryptionKey } from "../db/encryption";
import { getConnection, updateConnectionById, upsertConnection } from "../db/repos/app-connection";
import { EgressRefusedError } from "../runtime/http-egress";
import { sanitizedEnv } from "../../util/subprocess-env";
import {
  ConnectionCredentialError,
  guardedTokenTransport,
  oauth2ExpiresAt,
  PastedOAuth2Refresher,
  pastedOAuth2Status,
  REFRESH_AHEAD_MS,
  stampOAuth2Claim,
  type TokenTransport,
} from "./pasted-oauth2";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const NOW_S = NOW / 1000;
const SECRETS = { access_token: "ya29.old-access", refresh_token: "1//refresh-secret", client_secret: "client-secret-value" };

beforeEach(() => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 7));
});
afterEach(() => {
  closeWorkflowDb();
  setEncryptionKey(null);
});

/** A pasted Google-shaped row whose token expires `expiresInS` seconds after NOW. */
function pasted(expiresInS: number, extra: Record<string, unknown> = {}) {
  const value = { ...SECRETS, client_id: "client-id", token_url: "https://oauth2.example.test/token", token_type: "Bearer",
    claimed_at: NOW_S - 3599 + expiresInS, expires_in: 3599, ...extra };
  for (const [key, v] of Object.entries(value)) if (v === undefined) delete (value as Record<string, unknown>)[key];
  const row = upsertConnection({ externalId: "work-gmail", displayName: "Work Gmail", type: "OAUTH2",
    pieceName: "@activepieces/piece-gmail", pieceVersion: "0.0.0", value });
  return { id: row.id, projectId: row.projectId, externalId: row.externalId, type: row.type, value: row.value, generation: row.credentialGeneration };
}

/** A transport that records each call and answers what the test says, when the test says. */
function recordingTransport(answer: () => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }) {
  const calls: Array<{ url: string; form: Record<string, string>; headers: Record<string, string> }> = [];
  const transport: TokenTransport = async (url, form, headers) => {
    calls.push({ url: url.toString(), form: Object.fromEntries(form), headers });
    return answer();
  };
  return { calls, transport };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("#954 pasted OAuth2 refresh", () => {
  test("a token inside the refresh window is refreshed, stored, and the connection stays the same credential (Q-05)", async () => {
    const conn = pasted(10 * 60);
    const generation = getConnection(conn.id)!.credentialGeneration;
    const { calls, transport } = recordingTransport(() => ({ status: 200,
      body: { access_token: "ya29.new-access", expires_in: 3599, token_type: "Bearer", refresh_token: "1//rotated" } }));
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });

    const value = await refresher.fresh(conn);

    expect(calls).toEqual([{ url: "https://oauth2.example.test/token", headers: {
      "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      form: { grant_type: "refresh_token", refresh_token: "1//refresh-secret", client_id: "client-id", client_secret: "client-secret-value" } }]);
    expect(value).toMatchObject({ access_token: "ya29.new-access", refresh_token: "1//rotated", claimed_at: NOW_S, expires_in: 3599,
      client_id: "client-id", client_secret: "client-secret-value", token_url: "https://oauth2.example.test/token" });
    const stored = getConnection(conn.id)!;
    expect(stored.value).toEqual(value);
    expect(stored.credentialGeneration).toBe(generation);
  });

  test("a provider that does not rotate keeps the stored refresh token, and a missing expires_in gets upstream's hour", async () => {
    const conn = pasted(-5);
    const { transport } = recordingTransport(() => ({ status: 200, body: { access_token: "ya29.new" } }));
    const value = await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn);
    expect(value).toMatchObject({ access_token: "ya29.new", refresh_token: "1//refresh-secret", claimed_at: NOW_S, expires_in: 3600 });
  });

  test("an absolute expiry_date is honoured and replaced by claimed_at + expires_in once refreshed", async () => {
    const conn = pasted(0, { claimed_at: undefined, expires_in: undefined, expiry_date: NOW + 60_000 });
    const { transport } = recordingTransport(() => ({ status: 200, body: { access_token: "ya29.new", expires_in: 1800 } }));
    const value = await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn);
    expect(value.expiry_date).toBeUndefined();
    expect(value).toMatchObject({ claimed_at: NOW_S, expires_in: 1800 });
  });

  test("the HEADER authorization method sends the client credentials as Basic auth, not in the body", async () => {
    const conn = pasted(-5, { authorization_method: "HEADER" });
    const { calls, transport } = recordingTransport(() => ({ status: 200, body: { access_token: "ya29.new", expires_in: 3599 } }));
    await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn);
    expect(calls[0]!.form).toEqual({ grant_type: "refresh_token", refresh_token: "1//refresh-secret" });
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from("client-id:client-secret-value").toString("base64")}`);
  });

  test("a token good for longer than the window is handed out as stored, with no request", async () => {
    const conn = pasted(REFRESH_AHEAD_MS / 1000 + 60);
    const { calls, transport } = recordingTransport(() => { throw new Error("must not be called"); });
    expect(await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn)).toBe(conn.value);
    expect(calls).toHaveLength(0);
  });

  test("a row with no stated expiry and no refresh details is handed out as stored: Jarvis cannot tell when it expires", async () => {
    const conn = pasted(0, { claimed_at: undefined, expires_in: undefined, refresh_token: undefined });
    const { calls, transport } = recordingTransport(() => { throw new Error("must not be called"); });
    expect(await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn)).toBe(conn.value);
    expect(calls).toHaveLength(0);
  });

  test("a refreshable row saved undated (before #954) is refreshed on first use, which dates it", async () => {
    const conn = pasted(0, { claimed_at: undefined });
    const { calls, transport } = recordingTransport(() => ({ status: 200, body: { access_token: "ya29.dated", expires_in: 3599 } }));
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });
    expect(await refresher.fresh(conn)).toMatchObject({ access_token: "ya29.dated", claimed_at: NOW_S });
    expect(pastedOAuth2Status("OAUTH2", conn.value)).toEqual({ expiresAt: null, refreshable: true });
    const stored = getConnection(conn.id)!;
    expect(await refresher.fresh({ ...conn, value: stored.value })).toBe(stored.value);
    expect(calls).toHaveLength(1);
  });

  test("an undated row whose refresh fails is handed out as stored: it is not known to have expired", async () => {
    const conn = pasted(0, { claimed_at: undefined });
    const { transport } = recordingTransport(() => ({ status: 400, body: { error: "invalid_grant" } }));
    expect(await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn)).toEqual(conn.value);
  });

  test("a refresh the provider refused is not POSTed again for the same stored value; a new value is tried", async () => {
    const conn = pasted(-5);
    const { calls, transport } = recordingTransport(() => ({ status: 400, body: { error: "invalid_grant" } }));
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });
    for (let i = 0; i < 3; i++) {
      expect(((await refresher.fresh(conn).catch((e: unknown) => e)) as ConnectionCredentialError).code).toBe("CONNECTION_EXPIRED");
    }
    expect(calls).toHaveLength(1);
    const repasted = updateConnectionById(DEFAULT_IDS.project, conn.id, { value: { ...conn.value, refresh_token: "1//new-grant" } })!;
    await refresher.fresh({ ...conn, value: repasted.value, generation: repasted.credentialGeneration }).catch(() => undefined);
    expect(calls).toHaveLength(2);
  });

  test("a caller that waited, and whose credential a person replaced again meanwhile, gets CONNECTION_CHANGED and sends nothing", async () => {
    const conn = pasted(-5);
    const gate = deferred<{ status: number; body: unknown }>();
    const { calls, transport } = recordingTransport(() => gate.promise);
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });
    const first = refresher.fresh(conn).catch((e: unknown) => e);
    const b = updateConnectionById(DEFAULT_IDS.project, conn.id, { value: { ...conn.value, access_token: "ya29.b" } })!;
    const waiter = refresher.fresh({ ...conn, value: b.value, generation: b.credentialGeneration }).catch((e: unknown) => e);
    updateConnectionById(DEFAULT_IDS.project, conn.id, { value: { ...conn.value, access_token: "ya29.c", refresh_token: "1//c" } });
    gate.resolve({ status: 200, body: { access_token: "ya29.from-a", expires_in: 3599 } });
    await first;
    expect(((await waiter) as ConnectionCredentialError).code).toBe("CONNECTION_CHANGED");
    expect(calls).toHaveLength(1);
  });

  test("an unreachable endpoint for a token not yet expired is tried once per refresh window, the stored token handed out meanwhile", async () => {
    const conn = pasted(10 * 60);
    let clock = NOW;
    const { calls, transport } = recordingTransport(() => ({ status: 503, body: null }));
    const refresher = new PastedOAuth2Refresher(transport, { now: () => clock });
    expect(await refresher.fresh(conn)).toEqual(conn.value);
    expect(await refresher.fresh(conn)).toEqual(conn.value);
    expect(calls).toHaveLength(1);
    clock = NOW + 9 * 60_000;
    expect(await refresher.fresh(conn)).toEqual(conn.value);
    expect(calls).toHaveLength(1);
    // Expired now: nothing to hand out, so every fetch tries again.
    clock = NOW + 11 * 60_000;
    await refresher.fresh(conn).catch(() => undefined);
    await refresher.fresh(conn).catch(() => undefined);
    expect(calls).toHaveLength(3);
  });

  test("an undated refreshable row behind an unreachable endpoint is tried again only after the refresh window", async () => {
    const conn = pasted(0, { claimed_at: undefined });
    let clock = NOW;
    const { calls, transport } = recordingTransport(() => ({ status: 503, body: null }));
    const refresher = new PastedOAuth2Refresher(transport, { now: () => clock });
    await refresher.fresh(conn);
    await refresher.fresh(conn);
    expect(calls).toHaveLength(1);
    clock = NOW + REFRESH_AHEAD_MS;
    await refresher.fresh(conn);
    expect(calls).toHaveLength(2);
  });

  test("an unreachable endpoint is not remembered for an expired token: the next fetch tries again", async () => {
    const conn = pasted(-5);
    const { calls, transport } = recordingTransport(() => ({ status: 503, body: null }));
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });
    await refresher.fresh(conn).catch(() => undefined);
    await refresher.fresh(conn).catch(() => undefined);
    expect(calls).toHaveLength(2);
  });

  test("a lifetime of zero or less is treated as absent, so the next fetch does not refresh again", async () => {
    const conn = pasted(-5);
    const { transport } = recordingTransport(() => ({ status: 200, body: { access_token: "ya29.n", expires_in: 0 } }));
    expect(await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn)).toMatchObject({ expires_in: 3600 });
  });

  test("an expiry_date in ms is read as ms, and one in seconds as seconds, not as 1970", () => {
    expect(oauth2ExpiresAt({ expiry_date: NOW + 60_000 })).toBe(NOW + 60_000);
    expect(oauth2ExpiresAt({ expiry_date: NOW_S + 60 })).toBe(NOW + 60_000);
  });

  test("a row whose expiry_date is in seconds and still in the future is handed out, not refused as expired", async () => {
    const conn = pasted(0, { claimed_at: undefined, expires_in: undefined, refresh_token: undefined, expiry_date: NOW_S + 3000 });
    const { transport } = recordingTransport(() => { throw new Error("must not be called"); });
    expect(await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn)).toBe(conn.value);
  });

  test("a caller holding a snapshot from before a finished refresh re-reads the row: no POST of the retired refresh token", async () => {
    const conn = pasted(-5);
    const { calls, transport } = recordingTransport(() => ({ status: 200,
      body: { access_token: "ya29.fresh", expires_in: 3599, refresh_token: "1//rotated" } }));
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });
    await refresher.fresh(conn);
    // The stale snapshot still holds the retired refresh token and an expired access token.
    const value = await refresher.fresh(conn);
    expect(value).toMatchObject({ access_token: "ya29.fresh", refresh_token: "1//rotated" });
    expect(calls).toHaveLength(1);
  });

  test("an expiry no Date can hold is no expiry, not a crash", async () => {
    const conn = pasted(0, { claimed_at: -1e300, refresh_token: undefined });
    const { transport } = recordingTransport(() => { throw new Error("must not be called"); });
    expect(await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn)).toBe(conn.value);
  });

  test("concurrent fetches of one row share one refresh", async () => {
    const conn = pasted(-5);
    const gate = deferred<{ status: number; body: unknown }>();
    const { calls, transport } = recordingTransport(() => gate.promise);
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });
    const first = refresher.fresh(conn);
    const second = refresher.fresh(conn);
    gate.resolve({ status: 200, body: { access_token: "ya29.once", expires_in: 3599, refresh_token: "1//rotated-once" } });
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a.access_token).toBe("ya29.once");
  });

  test("an expired token with no refresh details is refused with a typed reason, never handed out", async () => {
    const conn = pasted(-5, { refresh_token: undefined });
    const { calls, transport } = recordingTransport(() => { throw new Error("must not be called"); });
    const error = await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionCredentialError);
    expect((error as ConnectionCredentialError).code).toBe("CONNECTION_EXPIRED");
    expect((error as Error).message).toContain("work-gmail");
    expect(calls).toHaveLength(0);
  });

  test("a token with no refresh details is handed out until it has actually expired", async () => {
    const conn = pasted(60, { refresh_token: undefined });
    const { transport } = recordingTransport(() => { throw new Error("must not be called"); });
    expect(await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn)).toBe(conn.value);
  });

  test("a token URL that is not https makes the row unrefreshable: the request would carry the client secret in clear", async () => {
    const conn = pasted(-5, { token_url: "http://oauth2.example.test/token" });
    const { calls, transport } = recordingTransport(() => { throw new Error("must not be called"); });
    const error = await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn).catch((e: unknown) => e);
    expect((error as ConnectionCredentialError).code).toBe("CONNECTION_EXPIRED");
    expect(calls).toHaveLength(0);
    expect(pastedOAuth2Status("OAUTH2", conn.value)).toEqual({ expiresAt: NOW - 5000, refreshable: false });
  });

  test("a refused refresh of an expired token is CONNECTION_EXPIRED, names the OAuth code, and carries no secret", async () => {
    const conn = pasted(-5);
    const { transport } = recordingTransport(() => ({ status: 400,
      body: { error: "invalid_grant", error_description: `Token ${SECRETS.refresh_token} has been revoked` } }));
    const error = await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn).catch((e: unknown) => e) as ConnectionCredentialError;
    expect(error.code).toBe("CONNECTION_EXPIRED");
    expect(error.message).toContain("HTTP 400, invalid_grant");
    for (const secret of Object.values(SECRETS)) expect(error.message).not.toContain(secret);
    expect(getConnection(conn.id)!.value).toEqual(conn.value);
  });

  test("an error field that is not an OAuth code is not echoed", async () => {
    const conn = pasted(-5);
    const { transport } = recordingTransport(() => ({ status: 401, body: { error: "Bearer leaked-secret-xyz is bad" } }));
    const error = await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn).catch((e: unknown) => e) as ConnectionCredentialError;
    expect(error.message).toContain("HTTP 401)");
    expect(error.message).not.toContain("leaked-secret-xyz");
  });

  test("an unreachable or failing token endpoint is CONNECTION_REFRESH_UNREACHABLE once the token has expired", async () => {
    for (const answer of [() => { throw new Error(`ECONNREFUSED ${SECRETS.client_secret}`); }, () => ({ status: 503, body: null })]) {
      const conn = pasted(-5);
      const error = await new PastedOAuth2Refresher(recordingTransport(answer).transport, { now: () => NOW }).fresh(conn)
        .catch((e: unknown) => e) as ConnectionCredentialError;
      expect(error.code).toBe("CONNECTION_REFRESH_UNREACHABLE");
      expect(error.message).not.toContain(SECRETS.client_secret);
      closeWorkflowDb(); initWorkflowDb(":memory:");
    }
  });

  test("a failed refresh while the stored token still works hands the stored token out", async () => {
    const conn = pasted(60);
    const { calls, transport } = recordingTransport(() => ({ status: 503, body: null }));
    expect(await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn)).toEqual(conn.value);
    expect(calls).toHaveLength(1);
  });

  test("an egress refusal is CONNECTION_EXPIRED: the token URL itself is the problem", async () => {
    const conn = pasted(-5);
    const transport: TokenTransport = async () => { throw new EgressRefusedError("refused"); };
    const error = await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn).catch((e: unknown) => e) as ConnectionCredentialError;
    expect(error.code).toBe("CONNECTION_EXPIRED");
    expect(error.message).toContain("oauth2.example.test");
  });

  test("a credential a person saved during the refresh stands; the refreshed one is dropped", async () => {
    const conn = pasted(-5);
    const gate = deferred<{ status: number; body: unknown }>();
    const { transport } = recordingTransport(() => gate.promise);
    const pending = new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn).catch((e: unknown) => e);
    // fresh() has already reached the transport, which is waiting on the gate: the person saves a new token now.
    const theirs = { ...conn.value, access_token: "ya29.pasted-by-person" };
    updateConnectionById(DEFAULT_IDS.project, conn.id, { value: theirs });
    gate.resolve({ status: 200, body: { access_token: "ya29.refreshed", expires_in: 3599 } });
    const error = await pending as ConnectionCredentialError;
    expect(error).toBeInstanceOf(ConnectionCredentialError);
    expect(error.code).toBe("CONNECTION_CHANGED");
    expect(getConnection(conn.id)!.value).toEqual(theirs);
  });

  test("a person who kept the refresh token while the provider rotated it gets the rotated one, and the rest of their save", async () => {
    const conn = pasted(-5);
    const gate = deferred<{ status: number; body: unknown }>();
    const { transport } = recordingTransport(() => gate.promise);
    const pending = new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn).catch((e: unknown) => e);
    const theirs = { ...conn.value, scope: "https://mail.google.com/" };
    const generation = updateConnectionById(DEFAULT_IDS.project, conn.id, { value: theirs })!.credentialGeneration;
    gate.resolve({ status: 200, body: { access_token: "ya29.refreshed", expires_in: 3599, refresh_token: "1//rotated" } });
    const error = await pending as ConnectionCredentialError;
    expect(error.code).toBe("CONNECTION_CHANGED");
    expect(error.message).toContain("rotated refresh token was kept");
    expect(getConnection(conn.id)!.value).toEqual({ ...theirs, refresh_token: "1//rotated" });
    expect(getConnection(conn.id)!.credentialGeneration).toBe(generation);
  });

  test("a caller holding a newer saved value does not take the stale refresh's outcome; it refreshes its own", async () => {
    const conn = pasted(-5);
    const gates = [deferred<{ status: number; body: unknown }>(), deferred<{ status: number; body: unknown }>()];
    let n = 0;
    const { calls, transport } = recordingTransport(() => gates[n++]!.promise);
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });
    const stale = refresher.fresh(conn).catch((e: unknown) => e);
    const v2 = updateConnectionById(DEFAULT_IDS.project, conn.id, { value: { ...conn.value, access_token: "ya29.v2", refresh_token: "1//v2" } })!;
    const newer = refresher.fresh({ ...conn, value: v2.value, generation: v2.credentialGeneration });
    gates[0]!.resolve({ status: 200, body: { access_token: "ya29.from-v1", expires_in: 3599 } });
    expect(((await stale) as ConnectionCredentialError).code).toBe("CONNECTION_CHANGED");
    // The newer caller's own refresh starts only once the stale one settled.
    while (calls.length < 2) await new Promise((r) => setImmediate(r));
    gates[1]!.resolve({ status: 200, body: { access_token: "ya29.from-v2", expires_in: 3599 } });
    expect((await newer).access_token).toBe("ya29.from-v2");
    expect(calls.map((c) => c.form.refresh_token)).toEqual(["1//refresh-secret", "1//v2"]);
  });

  test("a caller that waited out a refresh which rotated the token refreshes with the rotated token, never the retired one", async () => {
    const conn = pasted(-5);
    const gates = [deferred<{ status: number; body: unknown }>(), deferred<{ status: number; body: unknown }>()];
    let n = 0;
    const { calls, transport } = recordingTransport(() => gates[n++]!.promise);
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });
    const first = refresher.fresh(conn).catch((e: unknown) => e);
    // A person saves B, keeping the refresh token the refresh in flight is spending.
    const b = updateConnectionById(DEFAULT_IDS.project, conn.id, { value: { ...conn.value, scope: "https://mail.google.com/" } })!;
    const waiter = refresher.fresh({ ...conn, value: b.value, generation: b.credentialGeneration });
    gates[0]!.resolve({ status: 200, body: { access_token: "ya29.from-a", expires_in: 3599, refresh_token: "1//rotated" } });
    expect(((await first) as ConnectionCredentialError).code).toBe("CONNECTION_CHANGED");
    while (calls.length < 2) await new Promise((r) => setImmediate(r));
    gates[1]!.resolve({ status: 200, body: { access_token: "ya29.from-b", expires_in: 3599 } });
    expect((await waiter).access_token).toBe("ya29.from-b");
    expect(calls.map((c) => c.form.refresh_token)).toEqual(["1//refresh-secret", "1//rotated"]);
  });

  test("the failure log line quotes the connection's id, so a newline in it cannot forge a second line, and carries no secret", async () => {
    const conn = { ...pasted(-5), externalId: "evil\n[workflow-credentials] forged" };
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const { transport } = recordingTransport(() => ({ status: 400, body: { error: "invalid_grant" } }));
      await new PastedOAuth2Refresher(transport, { now: () => NOW }).fresh(conn).catch(() => undefined);
    } finally { console.warn = original; }
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).toContain('"evil\\n[workflow-credentials] forged"');
    for (const secret of Object.values(SECRETS)) expect(lines[0]).not.toContain(secret);
  });

  test("a failed refresh hands out the row as it is now, with a rotated refresh token, not the snapshot from before waiting", async () => {
    const conn = pasted(10 * 60);
    const gates = [deferred<{ status: number; body: unknown }>(), deferred<{ status: number; body: unknown }>()];
    let n = 0;
    const { transport } = recordingTransport(() => gates[n++]!.promise);
    const refresher = new PastedOAuth2Refresher(transport, { now: () => NOW });
    const first = refresher.fresh(conn).catch((e: unknown) => e);
    const b = updateConnectionById(DEFAULT_IDS.project, conn.id, { value: { ...conn.value, scope: "s" } })!;
    const waiter = refresher.fresh({ ...conn, value: b.value, generation: b.credentialGeneration });
    gates[0]!.resolve({ status: 200, body: { access_token: "ya29.from-a", expires_in: 3599, refresh_token: "1//rotated" } });
    await first;
    // The re-read row is refreshed again and that fails; the stored token still works, so it is handed out as stored now.
    gates[1]!.resolve({ status: 503, body: null });
    expect((await waiter).refresh_token).toBe("1//rotated");
  });

  test("non-OAuth2 rows are never touched", async () => {
    const { calls, transport } = recordingTransport(() => { throw new Error("must not be called"); });
    const value = { secret_text: "x", claimed_at: 1, expires_in: 1 };
    expect(await new PastedOAuth2Refresher(transport, { now: () => NOW })
      .fresh({ id: "x", projectId: "p", externalId: "e", type: "SECRET_TEXT", value, generation: 0 })).toBe(value);
    expect(calls).toHaveLength(0);
    expect(pastedOAuth2Status("SECRET_TEXT", value)).toBeNull();
  });
});

describe("#954 dating a pasted token", () => {
  test("expires_in with no claim time is dated now", () => {
    expect(stampOAuth2Claim("OAUTH2", { access_token: "a", expires_in: 3599 }, null, NOW)).toEqual({ access_token: "a", expires_in: 3599, claimed_at: NOW_S });
  });
  test("the same token saved again over an undated row (saved before #954) stays undated: not a replacement", () => {
    const value = { access_token: "a", expires_in: 3599 };
    expect(stampOAuth2Claim("OAUTH2", value, { access_token: "a", expires_in: 3599 }, NOW)).toBe(value);
  });
  test("the same access token saved again keeps its claim time, so it stays the same credential", () => {
    const previous = { access_token: "a", expires_in: 3599, claimed_at: NOW_S - 100 };
    expect(stampOAuth2Claim("OAUTH2", { access_token: "a", expires_in: 3599 }, previous, NOW)).toEqual(previous);
    expect(stampOAuth2Claim("OAUTH2", { access_token: "b", expires_in: 3599 }, previous, NOW).claimed_at).toBe(NOW_S);
  });
  test("a value that already says when, or never says, is left as it is", () => {
    for (const value of [{ access_token: "a", expires_in: 1, claimed_at: 5 }, { access_token: "a", expiry_date: 5 }, { access_token: "a" }]) {
      expect(stampOAuth2Claim("OAUTH2", value, null, NOW)).toBe(value);
    }
    expect(stampOAuth2Claim("SECRET_TEXT", { expires_in: 5 }, null, NOW)).toEqual({ expires_in: 5 });
  });
});

describe("#954 the token request goes through the workflow egress guard (#961)", () => {
  const form = new URLSearchParams({ grant_type: "refresh_token" });

  test("an IP-literal token URL outside the policy is refused before any connection", async () => {
    let hits = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits++; return new Response("{}"); } });
    try {
      const transport = guardedTokenTransport("private-allowed");
      await expect(transport(new URL(`https://127.0.0.1:${server.port}/token`), form, {})).rejects.toBeInstanceOf(EgressRefusedError);
      expect(hits).toBe(0);
    } finally { server.stop(true); }
  });

  test("a name that resolves to a refused address is refused at lookup, before any connection", async () => {
    let hits = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits++; return new Response("{}"); } });
    try {
      const resolve = ((_host: string, _opts: unknown, cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void) =>
        cb(null, [{ address: "127.0.0.1", family: 4 }])) as never;
      const error = await guardedTokenTransport("public-only", { resolve, timeoutMs: 5_000 })(
        new URL(`https://token.example.test:${server.port}/token`), form, {}).catch((e: unknown) => e);
      expect(String((error as Error)?.message)).toContain("127.0.0.1");
      expect(hits).toBe(0);
    } finally { server.stop(true); }
  });

  test("a token endpoint that accepts and then stalls is abandoned at the deadline, not awaited forever", async () => {
    const { createServer } = await import("node:net");
    const sockets: import("node:net").Socket[] = [];
    // Unreferenced, so a regressed transport fails this test at its timeout instead of keeping the process alive.
    const silent = createServer((socket) => { socket.unref(); sockets.push(socket); });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    silent.unref();
    try {
      const port = (silent.address() as { port: number }).port;
      const transport = guardedTokenTransport("public-only", { allowAddress: () => true, timeoutMs: 300 });
      await expect(transport(new URL(`https://127.0.0.1:${port}/token`), form, {})).rejects.toThrow("timed out");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  test("http is refused outright", async () => {
    await expect(guardedTokenTransport("private-allowed")(new URL("http://oauth2.example.test/token"), form, {}))
      .rejects.toBeInstanceOf(EgressRefusedError);
  });

  // Measured: on Bun 1.3.8, 1.3.9 and 1.3.10, node:https given a `lookup`
  // rewrites the request to the resolved IP and fails with
  // ERR_TLS_CERT_ALTNAME_INVALID even for a certificate that lists that IP
  // (`servername` and `checkServerIdentity` do not change it). Bun 1.3.11,
  // 1.3.12, 1.3.14 and 1.4.2 (CI and the release image) verify the host
  // name. On an older Bun a refresh fails closed.
  const [major, minor, patch] = Bun.version.split(".").map(Number) as [number, number, number];
  const verifiesHostName = major > 1 || minor > 3 || (minor === 3 && patch >= 11);
  const selfSigned = (dir: string) => {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      "-days", "1", "-subj", "/CN=token.example.test", "-addext", "subjectAltName=DNS:token.example.test"], { stdio: "ignore", env: sanitizedEnv() });
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  };
  const loopbackResolve = ((_host: string, _opts: unknown, cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void) =>
    cb(null, [{ address: "127.0.0.1", family: 4 }])) as never;

  test.skipIf(verifiesHostName || !Bun.which("openssl"))("on a Bun that cannot verify the host name, a refresh fails closed and sends nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-954-tls-"));
    try {
      const { key, cert } = selfSigned(dir);
      let hits = 0;
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { key, cert }, fetch: () => { hits++; return Response.json({}); } });
      try {
        const transport = guardedTokenTransport("public-only", { resolve: loopbackResolve, allowAddress: () => true, ca: cert, timeoutMs: 5_000 });
        await expect(transport(new URL(`https://token.example.test:${server.port}/token`), form, {})).rejects.toBeDefined();
        expect(hits).toBe(0);
      } finally { server.stop(true); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test.skipIf(!verifiesHostName || !Bun.which("openssl"))("an allowed name connects to the address it was checked at, over verified TLS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-954-tls-"));
    try {
      const { key, cert } = selfSigned(dir);
      const seen: string[] = [];
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { key, cert }, fetch: async (req) => {
        seen.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`);
        return Response.json({ access_token: "fresh", expires_in: 3599 });
      } });
      try {
        const looked: string[] = [];
        const resolve = ((host: string, _opts: unknown, cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void) => {
          looked.push(host); cb(null, [{ address: "127.0.0.1", family: 4 }]);
        }) as never;
        // The test allows loopback in place of a public address; the lookup itself is the production one.
        const transport = guardedTokenTransport("public-only", { resolve, allowAddress: () => true, ca: cert, timeoutMs: 5_000 });
        const answer = await transport(new URL(`https://token.example.test:${server.port}/token`), form,
          { "content-type": "application/x-www-form-urlencoded" });
        expect(answer).toEqual({ status: 200, body: { access_token: "fresh", expires_in: 3599 } });
        expect(looked).toEqual(["token.example.test"]);
        expect(seen).toEqual(["POST /token grant_type=refresh_token"]);
      } finally { server.stop(true); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
