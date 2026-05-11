/**
 * Adapter: PieceNotifier over Jarvis' ChannelService + WebSocketService +
 * desktop notifications.
 *
 * Channel routing rules:
 *
 *   "auto"      -> the user's last-known recipient on each connected channel
 *                  (M8's `lastRecipients`), plus a dashboard broadcast.
 *   "telegram"  -> ChannelService.broadcastToAll('telegram') if a recipient
 *                  is known; otherwise a single failure entry.
 *   "discord"   -> same idea on Discord.
 *   "voice"     -> not yet wired here (M10 lives elsewhere); reported as
 *                  failed("voice", "not yet wired") so flows surface it.
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
}

export interface NotifierBroadcastReport {
  delivered: string[];
  failed: { channel: string; error: string }[];
}

export class JarvisNotifierAdapter implements PieceNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  async notify(input: PieceNotifyInput): Promise<PieceNotifyResult> {
    const requested = input.channels && input.channels.length > 0 ? input.channels : (["auto"] as PieceNotifyChannel[]);
    const expanded = expandChannels(requested);
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

function expandChannels(requested: PieceNotifyChannel[]): Set<string> {
  const out = new Set<string>();
  for (const c of requested) {
    if (c === "auto") {
      // Default policy: dashboard always, plus telegram + discord (best effort).
      // The underlying broadcast methods absorb missing recipients gracefully.
      out.add("dashboard");
      out.add("telegram");
      out.add("discord");
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
