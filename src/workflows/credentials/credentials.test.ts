import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from "../db/index";
import { upsertConnection } from "../db/repos/app-connection";
import {
  CredentialResolver,
  JARVIS_PREFIX,
  JarvisDiscordSource,
  JarvisGoogleSource,
  JarvisTelegramSource,
  type JarvisConnectionSource,
} from "./adapter";

beforeEach(() => {
  initWorkflowDb(":memory:");
});

afterEach(() => {
  closeWorkflowDb();
});

describe("CredentialResolver", () => {
  test("dispatches jarvis:* externalIds to a registered Jarvis source", async () => {
    const r = new CredentialResolver();
    r.register(new JarvisTelegramSource(() => "live-bot-token"));
    const got = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "telegram-bot",
      externalId: `${JARVIS_PREFIX}telegram`,
    });
    expect(got).toEqual({ type: "SECRET_TEXT", value: { secret_text: "live-bot-token" } });
  });

  test("returns null when a Jarvis source cannot resolve (not yet authenticated)", async () => {
    const r = new CredentialResolver();
    r.register(new JarvisGoogleSource(async () => null));
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
    r.register(new JarvisGoogleSource(async () => "live-token"));
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
      canResolve: (id) => id === `${JARVIS_PREFIX}custom`,
      resolve: async () => {
        calls++;
        return { type: "NO_AUTH", value: {} };
      },
    };
    r.register(dummy);
    r.register(new JarvisTelegramSource(() => "tg"));
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
    const source = new JarvisDiscordSource(() => "dc");
    r.register(source);
    r.unregister("discord");
    const got = await r.resolve({
      projectId: DEFAULT_IDS.project,
      pieceName: "discord",
      externalId: JarvisDiscordSource.EXTERNAL_ID,
    });
    expect(got).toBeNull();
  });
});

describe("JarvisGoogleSource", () => {
  test("resolves any of the gmail/calendar/drive externalIds to the same token", async () => {
    const source = new JarvisGoogleSource(async () => "tok");
    expect(source.canResolve(`${JARVIS_PREFIX}google`)).toBe(true);
    expect(source.canResolve(`${JARVIS_PREFIX}gmail`)).toBe(true);
    expect(source.canResolve(`${JARVIS_PREFIX}google-calendar`)).toBe(true);
    expect(source.canResolve(`${JARVIS_PREFIX}google-drive`)).toBe(true);
    expect(source.canResolve(`${JARVIS_PREFIX}other`)).toBe(false);
    const got = await source.resolve(`${JARVIS_PREFIX}gmail`);
    expect(got?.type).toBe("OAUTH2");
    expect(got?.value).toMatchObject({ access_token: "tok", token_type: "Bearer" });
  });

  test("propagates errors from getAccessToken (do not swallow refresh failures)", async () => {
    const source = new JarvisGoogleSource(async () => {
      throw new Error("refresh failed");
    });
    await expect(source.resolve(`${JARVIS_PREFIX}gmail`)).rejects.toThrow(/refresh failed/);
  });
});
