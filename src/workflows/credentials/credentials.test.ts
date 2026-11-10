import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from "../db/index";
import { setEncryptionKey } from "../db/encryption";
import { upsertConnection } from "../db/repos/app-connection";
import {
  CredentialResolver,
  JARVIS_PREFIX,
  type JarvisConnectionSource,
  type ResolvedConnection,
} from "./adapter";

// Pin the connection-encryption key: without it the module resolves the
// developer's real key file (and generates one into their live data dir).
beforeEach(() => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 0x13));
});

afterEach(() => {
  closeWorkflowDb();
  setEncryptionKey(null);
});

// Lightweight test stubs. The live sources (`JarvisGoogleConnectionSource`,
// `JarvisTelegramConnectionSource`) have their own dedicated test files that
// exercise the per-source contracts. These tests only care that the resolver
// dispatches correctly to whatever Source it's handed.
function stubSource(id: string, externalId: string, value: ResolvedConnection | null): JarvisConnectionSource {
  return {
    id,
    pieceNames: [],
    canResolve: (eid) => eid === externalId,
    resolve: async () => value,
  };
}

describe("CredentialResolver", () => {
  test("#1153: a SECRET_TEXT row saved as secret or value resolves under secret_text, for every reader", async () => {
    // The report and refund services read `resolved.value.secret_text` straight from the resolver.
    for (const [externalId, value] of [["legacy-secret", { secret: "sk_live_legacy" }], ["legacy-value", { value: "sk_live_legacy" }],
      ["both-same", { secret: "sk_live_legacy", value: "sk_live_legacy" }]] as const) {
      upsertConnection({ externalId, displayName: "Legacy", type: "SECRET_TEXT", pieceName: "@activepieces/piece-stripe", pieceVersion: "1", value });
      const got = await new CredentialResolver().resolve({ projectId: DEFAULT_IDS.project, pieceName: "@activepieces/piece-stripe", externalId });
      expect(`${externalId}: ${got?.value.secret_text}`).toBe(`${externalId}: sk_live_legacy`);
    }
    // Two different legacy values are not guessed between; a current row is as stored.
    upsertConnection({ externalId: "ambiguous", displayName: "L", type: "SECRET_TEXT", pieceName: "@activepieces/piece-stripe", pieceVersion: "1", value: { secret: "a", value: "b" } });
    expect((await new CredentialResolver().resolve({ projectId: DEFAULT_IDS.project, pieceName: "@activepieces/piece-stripe", externalId: "ambiguous" }))?.value.secret_text).toBeUndefined();
    upsertConnection({ externalId: "current", displayName: "C", type: "SECRET_TEXT", pieceName: "@activepieces/piece-stripe", pieceVersion: "1", value: { secret_text: "sk_now", secret: "old" } });
    expect((await new CredentialResolver().resolve({ projectId: DEFAULT_IDS.project, pieceName: "@activepieces/piece-stripe", externalId: "current" }))?.value.secret_text).toBe("sk_now");
  });

  test("dispatches jarvis:* externalIds to a registered Jarvis source", async () => {
    const r = new CredentialResolver();
    r.register(
      stubSource("telegram", `${JARVIS_PREFIX}telegram`, {
        type: "SECRET_TEXT",
        value: { secret_text: "live-bot-token" },
      }),
    );
    const got = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "telegram-bot",
      externalId: `${JARVIS_PREFIX}telegram`,
    });
    expect(got).toEqual({ type: "SECRET_TEXT", value: { secret_text: "live-bot-token" } });
  });

  test("returns null when a Jarvis source cannot resolve (not yet authenticated)", async () => {
    const r = new CredentialResolver();
    r.register(stubSource("google", `${JARVIS_PREFIX}gmail`, null));
    const got = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "gmail",
      externalId: `${JARVIS_PREFIX}gmail`,
    });
    expect(got).toBeNull();
  });

  test("returns null when no Jarvis source claims the externalId", async () => {
    const r = new CredentialResolver();
    const got = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "anything",
      externalId: `${JARVIS_PREFIX}unknown`,
    });
    expect(got).toBeNull();
  });

  test("falls back to the app_connection repo for non-jarvis externalIds", async () => {
    upsertConnection({
      externalId: "user-supplied",
      displayName: "Notion",
      type: "OAUTH2",
      pieceName: "notion",
      pieceVersion: "1.0.0",
      value: { access_token: "abc", token_type: "Bearer" },
    });
    const r = new CredentialResolver();
    const got = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "notion",
      externalId: "user-supplied",
    });
    expect(got?.type).toBe("OAUTH2");
    expect(got?.value).toMatchObject({ access_token: "abc" });
  });

  test("does not consult the DB for jarvis:* externalIds (isolation)", async () => {
    // Even if a row exists with externalId "jarvis:gmail", the resolver should
    // route through the Jarvis source path and not return DB values. This
    // guarantees the DB cannot shadow live-managed Jarvis credentials.
    upsertConnection({
      externalId: `${JARVIS_PREFIX}gmail`,
      displayName: "ghost",
      type: "OAUTH2",
      pieceName: "gmail",
      pieceVersion: "1.0.0",
      value: { access_token: "stale-from-db" },
    });
    const r = new CredentialResolver();
    r.register(
      stubSource("google", `${JARVIS_PREFIX}gmail`, {
        type: "OAUTH2",
        value: { access_token: "live-token" },
      }),
    );
    const got = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "gmail",
      externalId: `${JARVIS_PREFIX}gmail`,
    });
    expect(got?.value.access_token).toBe("live-token");
  });

  test("multiple sources: first matching wins", async () => {
    const r = new CredentialResolver();
    let calls = 0;
    const dummy: JarvisConnectionSource = {
      id: "dummy",
      pieceNames: [],
      canResolve: (id) => id === `${JARVIS_PREFIX}custom`,
      resolve: async () => {
        calls++;
        return { type: "NO_AUTH", value: {} };
      },
    };
    r.register(dummy);
    r.register(
      stubSource("telegram", `${JARVIS_PREFIX}telegram`, {
        type: "SECRET_TEXT",
        value: { secret_text: "tg" },
      }),
    );
    const a = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "x",
      externalId: `${JARVIS_PREFIX}custom`,
    });
    const b = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "telegram-bot",
      externalId: `${JARVIS_PREFIX}telegram`,
    });
    expect(a?.type).toBe("NO_AUTH");
    expect(b?.value.secret_text).toBe("tg");
    expect(calls).toBe(1);
  });

  test("unregister removes a source by id", async () => {
    const r = new CredentialResolver();
    const source = stubSource("discord", `${JARVIS_PREFIX}discord`, {
      type: "SECRET_TEXT",
      value: { secret_text: "dc" },
    });
    r.register(source);
    r.unregister("discord");
    const got = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "discord",
      externalId: `${JARVIS_PREFIX}discord`,
    });
    expect(got).toBeNull();
  });
});
