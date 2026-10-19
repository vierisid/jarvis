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
    broadcastToDashboard: () => 1,
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
          return true;
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

  test("a sendVoice that throws after starting may have played part of it: unknown", async () => {
    const adapter = new JarvisNotifierAdapter(
      makeDeps({
        sendVoice: async () => {
          throw new Error("websocket closed");
        },
      }),
    );
    const r = await adapter.notify({ message: "x", channels: ["voice"] });
    expect(r.failed).toEqual([]);
    expect(r.unknown).toEqual([{ channel: "voice", error: "websocket closed" }]);
  });

  test("nothing spoken is failed, not delivered", async () => {
    const adapter = new JarvisNotifierAdapter(makeDeps({ sendVoice: async () => false }));
    const r = await adapter.notify({ message: "x", channels: ["voice"] });
    expect(r.delivered).toEqual([]);
    expect(r.failed[0]?.channel).toBe("voice");
  });
});

// Q-19: a surface with nobody to show it to reports failed, never delivered,
// and a channel that may have taken it reports unknown, never failed.
describe("JarvisNotifierAdapter: honest receipts", () => {
  test("no open dashboard is failed, not delivered", async () => {
    const adapter = new JarvisNotifierAdapter(makeDeps({ broadcastToDashboard: () => 0 }));
    const r = await adapter.notify({ message: "x", channels: ["dashboard"] });
    expect(r).toEqual({ delivered: [], failed: [{ channel: "dashboard", error: "no dashboard was open" }], unknown: [] });
  });

  test("a desktop that did not show it is failed", async () => {
    const adapter = new JarvisNotifierAdapter(makeDeps({ sendDesktop: async () => false }));
    const r = await adapter.notify({ message: "x", channels: ["desktop"] });
    expect(r).toEqual({ delivered: [], failed: [{ channel: "desktop", error: "the desktop did not show it" }], unknown: [] });
  });

  test("unconfirmed channels pass through as unknown", async () => {
    const adapter = new JarvisNotifierAdapter(makeDeps({
      broadcastToChannels: async () => ({ delivered: ["discord"], failed: [], unknown: [{ channel: "telegram", error: "timed out" }] }),
    }));
    const r = await adapter.notify({ message: "x", channels: ["telegram", "discord"] });
    expect(r).toEqual({ delivered: ["discord"], failed: [], unknown: [{ channel: "telegram", error: "timed out" }] });
  });

  test("a router that throws part way leaves every channel unknown, not failed", async () => {
    const adapter = new JarvisNotifierAdapter(makeDeps({
      broadcastToChannels: async () => { throw new Error("router crashed"); },
    }));
    const r = await adapter.notify({ message: "x", channels: ["telegram", "discord"] });
    expect(r.failed).toEqual([]);
    expect(r.unknown.map((u) => u.channel)).toEqual(["telegram", "discord"]);
  });
});

describe("JarvisNotifierAdapter: channel expansion", () => {
  test('"auto" without getConnectedExternalChannels falls back to dashboard + telegram + discord', async () => {
    const calls: { dashboard: boolean; channels: string[] } = {
      dashboard: false,
      channels: [],
    };
    const adapter = new JarvisNotifierAdapter(
      makeDeps({
        broadcastToDashboard: () => {
          calls.dashboard = true;
          return 1;
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

  test('"auto" only fans out to *connected* external channels when the dep is wired', async () => {
    // Jarvis with only telegram wired -> auto goes to dashboard + telegram,
    // discord is silently skipped (it's not a failure -- it's just not
    // configured). Previously this would have reported
    // failed:[{channel:"discord", error:"not configured"}] every time.
    const calls: { channels: string[] } = { channels: [] };
    const adapter = new JarvisNotifierAdapter(
      makeDeps({
        broadcastToChannels: async (channels) => {
          calls.channels = channels;
          return { delivered: channels, failed: [] };
        },
        getConnectedExternalChannels: () => new Set(["telegram"]),
      }),
    );
    const r = await adapter.notify({ message: "x", channels: ["auto"] });
    expect(calls.channels).toEqual(["telegram"]);
    expect(r.delivered.sort()).toEqual(["dashboard", "telegram"]);
    expect(r.failed).toEqual([]);
  });

  test('"auto" on a Jarvis with no external channels connected only delivers to dashboard', async () => {
    let m8Called = false;
    const adapter = new JarvisNotifierAdapter(
      makeDeps({
        broadcastToChannels: async () => {
          m8Called = true;
          return { delivered: [], failed: [] };
        },
        getConnectedExternalChannels: () => new Set(),
      }),
    );
    const r = await adapter.notify({ message: "x", channels: ["auto"] });
    expect(m8Called).toBe(false);
    expect(r.delivered).toEqual(["dashboard"]);
    expect(r.failed).toEqual([]);
  });

  test("explicit ['telegram'] still attempts delivery regardless of connected set", async () => {
    // The auto-filter is *exclusively* for auto. Explicit selection means
    // the user asked for that channel by name; report the underlying
    // adapter's failure verbatim if it isn't connected.
    const calls: { channels: string[] } = { channels: [] };
    const adapter = new JarvisNotifierAdapter(
      makeDeps({
        broadcastToChannels: async (channels) => {
          calls.channels = channels;
          return {
            delivered: [],
            failed: channels.map((c) => ({ channel: c, error: "not configured" })),
          };
        },
        getConnectedExternalChannels: () => new Set(),
      }),
    );
    const r = await adapter.notify({ message: "x", channels: ["telegram"] });
    expect(calls.channels).toEqual(["telegram"]);
    expect(r.failed[0]?.channel).toBe("telegram");
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

// Review B1, owner rule: a dashboard `auto` chose is skipped when nobody is
// watching and the desktop shows it instead; a dashboard the step names is strict.
describe("JarvisNotifierAdapter: auto with no dashboard open", () => {
  test("auto skips the closed dashboard and shows it on the desktop", async () => {
    const shown: string[] = [];
    const adapter = new JarvisNotifierAdapter(makeDeps({ broadcastToDashboard: () => 0, getConnectedExternalChannels: () => new Set(),
      sendDesktop: async (_title, body) => { shown.push(body); return true; } }));
    expect(await adapter.notify({ message: "x", channels: ["auto"] })).toEqual({ delivered: ["desktop"], failed: [], unknown: [] });
    expect(shown).toEqual(["x"]);
  });

  test("a closed dashboard under auto is not reported failed when another channel delivered", async () => {
    const adapter = new JarvisNotifierAdapter(makeDeps({ broadcastToDashboard: () => 0, getConnectedExternalChannels: () => new Set(["telegram"]) }));
    expect(await adapter.notify({ message: "x", channels: ["auto"] })).toEqual({ delivered: ["telegram"], failed: [], unknown: [] });
  });

  test("when nothing reached anyone, the skipped dashboard is part of why", async () => {
    const adapter = new JarvisNotifierAdapter(makeDeps({ broadcastToDashboard: () => 0, getConnectedExternalChannels: () => new Set() }));
    expect(await adapter.notify({ message: "x", channels: ["auto"] }))
      .toEqual({ delivered: [], failed: [{ channel: "dashboard", error: "no dashboard was open" }], unknown: [] });
  });

  test("the governed step's frozen auto choice counts the same as auto itself", async () => {
    const adapter = new JarvisNotifierAdapter(makeDeps({ broadcastToDashboard: () => 0, sendDesktop: async () => true }));
    expect(await adapter.notify({ message: "x", channels: ["dashboard"], autoDashboard: true })).toEqual({ delivered: ["desktop"], failed: [], unknown: [] });
  });

  test("a dashboard the step names is strict, and the desktop is not tried for it", async () => {
    let desktop = 0;
    const adapter = new JarvisNotifierAdapter(makeDeps({ broadcastToDashboard: () => 0, sendDesktop: async () => { desktop++; return true; } }));
    expect(await adapter.notify({ message: "x", channels: ["dashboard"] }))
      .toEqual({ delivered: [], failed: [{ channel: "dashboard", error: "no dashboard was open" }], unknown: [] });
    expect(desktop).toBe(0);
  });
});

// Review C4: a desktop toast that did not confirm in time may be on screen.
test("a desktop toast that did not confirm in time is unknown, not failed", async () => {
  const adapter = new JarvisNotifierAdapter(makeDeps({ sendDesktop: async () => "unknown" }));
  expect(await adapter.notify({ message: "x", channels: ["desktop"] }))
    .toEqual({ delivered: [], failed: [], unknown: [{ channel: "desktop", error: "it did not confirm in time; it may have shown" }] });
});
