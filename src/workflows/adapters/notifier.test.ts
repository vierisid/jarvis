/**
 * `JarvisNotifierAdapter` covers the four channels the workflow notifier
 * piece supports: dashboard, M8 (telegram/discord/...), voice, desktop.
 * Tests here stub each backend so the routing logic can be exercised
 * without spinning up real adapters.
 */

import { describe, expect, test } from "bun:test";
import { JarvisNotifierAdapter, type NotifierDeps } from "./notifier";

function makeDeps(overrides: Partial<NotifierDeps> = {}): NotifierDeps {
  return {
    broadcastToDashboard: () => {},
    broadcastToChannels: async (channels) => ({
      delivered: channels,
      failed: [],
    }),
    ...overrides,
  };
}

describe("JarvisNotifierAdapter: voice channel", () => {
  test("delivers via sendVoice when wired", async () => {
    const spoken: string[] = [];
    const adapter = new JarvisNotifierAdapter(
      makeDeps({
        sendVoice: async (t) => {
          spoken.push(t);
        },
      }),
    );
    const r = await adapter.notify({ message: "hello world", channels: ["voice"] });
    expect(spoken).toEqual(["hello world"]);
    expect(r.delivered).toContain("voice");
    expect(r.failed).toEqual([]);
  });

  test("reports failed when sendVoice isn't wired", async () => {
    const adapter = new JarvisNotifierAdapter(makeDeps());
    const r = await adapter.notify({ message: "x", channels: ["voice"] });
    expect(r.delivered).not.toContain("voice");
    expect(r.failed[0]?.channel).toBe("voice");
    expect(r.failed[0]?.error).toMatch(/TTS provider not configured/);
  });

  test("surfaces sendVoice errors as failures", async () => {
    const adapter = new JarvisNotifierAdapter(
      makeDeps({
        sendVoice: async () => {
          throw new Error("websocket closed");
        },
      }),
    );
    const r = await adapter.notify({ message: "x", channels: ["voice"] });
    expect(r.failed[0]?.error).toMatch(/websocket closed/);
  });
});

describe("JarvisNotifierAdapter: channel expansion", () => {
  test('"auto" expands to dashboard + telegram + discord', async () => {
    const calls: { dashboard: boolean; channels: string[] } = {
      dashboard: false,
      channels: [],
    };
    const adapter = new JarvisNotifierAdapter(
      makeDeps({
        broadcastToDashboard: () => {
          calls.dashboard = true;
        },
        broadcastToChannels: async (channels) => {
          calls.channels = channels;
          return { delivered: channels, failed: [] };
        },
      }),
    );
    const r = await adapter.notify({ message: "x", channels: ["auto"] });
    expect(calls.dashboard).toBe(true);
    expect(calls.channels.sort()).toEqual(["discord", "telegram"]);
    expect(r.delivered).toContain("dashboard");
    expect(r.delivered).toContain("telegram");
    expect(r.delivered).toContain("discord");
  });

  test("dashboard channel routes only to the dashboard, not to M8", async () => {
    let m8Called = false;
    const adapter = new JarvisNotifierAdapter(
      makeDeps({
        broadcastToChannels: async (channels) => {
          m8Called = true;
          return { delivered: channels, failed: [] };
        },
      }),
    );
    await adapter.notify({ message: "x", channels: ["dashboard"] });
    expect(m8Called).toBe(false);
  });
});
