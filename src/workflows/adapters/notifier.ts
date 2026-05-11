/**
 * Adapter: PieceNotifier over Jarvis' ChannelService + WebSocketService +
 * desktop notifications.
 *
 * Channel routing rules:
 *
 *   "auto"      -> dashboard, plus the *configured + connected* subset of
 *                  external channels (telegram/discord) the daemon is
 *                  currently wired to. Unconfigured channels are silently
 *                  dropped here so a vanilla Jarvis without telegram doesn't
 *                  surface a "telegram failed: not configured" entry on
 *                  every auto notification. Explicit `["telegram"]` still
 *                  reports the failure -- the user asked for it by name.
 *   "telegram"  -> ChannelService.broadcastToChannels(['telegram']).
 *   "discord"   -> same idea on Discord.
 *   "voice"     -> TTS over the dashboard WS, when `sendVoice` is wired.
 *   "dashboard" -> WS broadcast to connected dashboards.
 *   "desktop"   -> sendDesktopNotification, when available.
 *
 * Each request returns which channels delivered and which failed; pieces
 * never throw on partial failure, so workflows can branch on the result.
 */

import type {
  PieceNotifier,
  PieceNotifyChannel,
  PieceNotifyInput,
  PieceNotifyPriority,
  PieceNotifyResult,
} from "../jarvis-pieces/types";

export interface NotifierDeps {
  /** Sends to every connected channel via M8. Returns void; errors are caught. */
  broadcastToChannels: (channels: string[], text: string) => Promise<NotifierBroadcastReport>;
  /** Broadcasts to all open dashboard websockets. Synchronous, never throws. */
  broadcastToDashboard: (text: string, priority: "urgent" | "normal" | "low") => void;
  /** Optional desktop notification surface (D-Bus / native). Optional means "platform may not have it". */
  sendDesktop?: (title: string, body: string) => Promise<void>;
  /**
   * Optional voice / TTS surface. When provided, `jarvis-notify` calls with
   * `channels: ["voice"]` synthesize speech and broadcast the audio to
   * connected dashboard websockets. The daemon's `WebSocketService` exposes
   * `broadcastProactiveVoice` for this. Missing means "TTS not configured"
   * and the channel reports as failed with a clear message.
   */
  sendVoice?: (text: string) => Promise<void>;
  /**
   * Returns the set of *external* channel names currently configured AND
   * connected (e.g. `{"telegram"}` on a Jarvis with only telegram wired).
   * Consulted exclusively by `auto`-channel expansion so unconfigured
   * channels don't surface as failures on every auto notification.
   *
   * Optional: when missing, `auto` falls back to the previous behaviour of
   * trying both telegram and discord. Explicit channel selections
   * (`["telegram"]`) ignore this entirely and always attempt delivery.
   */
  getConnectedExternalChannels?: () => Set<string>;
}

export interface NotifierBroadcastReport {
  delivered: string[];
  failed: { channel: string; error: string }[];
}

export class JarvisNotifierAdapter implements PieceNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  async notify(input: PieceNotifyInput): Promise<PieceNotifyResult> {
    const requested = input.channels && input.channels.length > 0 ? input.channels : (["auto"] as PieceNotifyChannel[]);
    const expanded = expandChannels(requested, this.deps);
    const priority = mapPriority(input.priority ?? "normal");

    const delivered: string[] = [];
    const failed: { channel: string; error: string }[] = [];

    // Dashboard
    if (expanded.has("dashboard")) {
      try {
        this.deps.broadcastToDashboard(input.message, priority);
        delivered.push("dashboard");
      } catch (e) {
        failed.push({ channel: "dashboard", error: errorMessage(e) });
      }
    }

    // M8 channels (telegram, discord, signal, etc.)
    const m8Channels = Array.from(expanded).filter((c) => c !== "dashboard" && c !== "voice" && c !== "desktop");
    if (m8Channels.length > 0) {
      try {
        const report = await this.deps.broadcastToChannels(m8Channels, input.message);
        for (const d of report.delivered) delivered.push(d);
        for (const f of report.failed) failed.push(f);
      } catch (e) {
        for (const c of m8Channels) failed.push({ channel: c, error: errorMessage(e) });
      }
    }

    // Voice -- TTS through the daemon's `broadcastProactiveVoice` when the
    // dep is wired. Speaks the message to every connected dashboard client
    // through the same WS path the awareness suggestions use. Falls back to
    // a clear failure when TTS isn't configured.
    if (expanded.has("voice")) {
      if (!this.deps.sendVoice) {
        failed.push({ channel: "voice", error: "voice channel not wired (TTS provider not configured)" });
      } else {
        try {
          await this.deps.sendVoice(input.message);
          delivered.push("voice");
        } catch (e) {
          failed.push({ channel: "voice", error: errorMessage(e) });
        }
      }
    }

    // Desktop
    if (expanded.has("desktop")) {
      if (!this.deps.sendDesktop) {
        failed.push({ channel: "desktop", error: "desktop notifications not available on this platform" });
      } else {
        try {
          await this.deps.sendDesktop(titleForPriority(priority), input.message);
          delivered.push("desktop");
        } catch (e) {
          failed.push({ channel: "desktop", error: errorMessage(e) });
        }
      }
    }

    return { delivered, failed };
  }
}

function expandChannels(requested: PieceNotifyChannel[], deps: NotifierDeps): Set<string> {
  const out = new Set<string>();
  for (const c of requested) {
    if (c === "auto") {
      // Dashboard always (in-app surface is always available when there's
      // an open dashboard WS; if none is open the broadcast is a silent
      // no-op). For external channels we consult the dep, when wired, to
      // skip unconfigured ones -- otherwise every auto notification on a
      // Jarvis without telegram/discord would report two failures the
      // user can't act on.
      out.add("dashboard");
      const live = deps.getConnectedExternalChannels?.();
      if (live) {
        for (const name of ["telegram", "discord"]) {
          if (live.has(name)) out.add(name);
        }
      } else {
        // Conservative fallback: when the dep isn't wired, behave as before
        // and try both. The downstream broadcast layer still reports
        // per-channel success / failure; flows that branch on
        // `failed.length === 0` will see noise, but at least the previous
        // behaviour is preserved for callers that haven't opted in.
        out.add("telegram");
        out.add("discord");
      }
    } else {
      out.add(c);
    }
  }
  return out;
}

function mapPriority(p: PieceNotifyPriority): "urgent" | "normal" | "low" {
  if (p === "high") return "urgent";
  if (p === "low") return "low";
  return "normal";
}

function titleForPriority(p: "urgent" | "normal" | "low"): string {
  if (p === "urgent") return "Jarvis (urgent)";
  return "Jarvis";
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
