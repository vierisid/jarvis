/**
 * Adapter: PieceNotifier over Jarvis' ChannelService + WebSocketService +
 * desktop notifications.
 *
 * Channel routing rules:
 *
 *   "auto"      -> dashboard, plus the *configured + connected* subset of
 *                  external channels (telegram/discord) the daemon is
 *                  currently wired to. With no dashboard open, auto skips it
 *                  (not a failure) and tries the desktop instead (Q-19). Unconfigured channels are silently
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
 * Each request returns which channels delivered, which failed, and which
 * may have taken the message without confirming it (`unknown`, Q-19: a
 * timeout or a dropped connection after sending). Delivered means a surface
 * accepted it: a dashboard socket, a channel, a desktop toast, spoken audio.
 * A surface with nobody to show it to reports failed, never delivered. This
 * adapter never throws on partial failure, so workflows can branch on the
 * result; the governed notify step fails only when nothing was sent anywhere.
 */

import { checkpointExecution } from "../../actions/execution-scope";
import type {
  PieceNotifier,
  PieceNotifyChannel,
  PieceNotifyInput,
  PieceNotifyPriority,
  PieceNotifyResult,
} from "../jarvis-pieces/types";

export interface NotifierDeps {
  /** Sends to the named external channels via M8 and reports each one. */
  broadcastToChannels: (channels: string[], text: string) => Promise<NotifierBroadcastReport>;
  /**
   * Broadcasts to all open dashboard websockets. Synchronous, never throws.
   * Returns how many sockets accepted it; 0 means no dashboard was open.
   */
  broadcastToDashboard: (text: string, priority: "urgent" | "normal" | "low") => number;
  /**
   * Optional desktop notification surface (D-Bus / native). Optional means
   * "platform may not have it". Resolves whether the desktop showed it, or
   * `'unknown'` when the sender timed out and the toast may already be up.
   */
  sendDesktop?: (title: string, body: string) => Promise<boolean | 'unknown'>;
  /**
   * Optional voice / TTS surface. When provided, `jarvis-notify` calls with
   * `channels: ["voice"]` synthesize speech and broadcast the audio to
   * connected dashboard websockets. The daemon's `WebSocketService` exposes
   * `broadcastProactiveVoice` for this. Missing means "TTS not configured"
   * and the channel reports as failed with a clear message. Resolves whether
   * anything was spoken.
   */
  sendVoice?: (text: string) => Promise<boolean>;
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
  /** Channels that may have taken the message without confirming it. Never "not sent". */
  unknown?: { channel: string; error: string }[];
}

export class JarvisNotifierAdapter implements PieceNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  async notify(input: PieceNotifyInput): Promise<PieceNotifyResult> {
    const requested = input.channels && input.channels.length > 0 ? input.channels : (["auto"] as PieceNotifyChannel[]);
    const expanded = expandChannels(requested, this.deps);
    const priority = mapPriority(input.priority ?? "normal");

    const delivered: string[] = [];
    const failed: { channel: string; error: string }[] = [];
    const unknown: { channel: string; error: string }[] = [];
    // Chosen by `auto`, the dashboard with nobody watching is skipped like an
    // unconnected channel and the desktop is tried instead. Named, it is strict.
    const autoDashboard = input.autoDashboard === true || (requested.includes("auto") && !requested.includes("dashboard"));
    const skipped: { channel: string; error: string }[] = [];

    // Dashboard
    if (expanded.has("dashboard")) {
      let started = false;
      try {
        checkpointExecution();
        started = true;
        if (this.deps.broadcastToDashboard(input.message, priority) > 0) delivered.push("dashboard");
        else if (autoDashboard) {
          skipped.push({ channel: "dashboard", error: "no dashboard was open" });
          if (this.deps.sendDesktop) expanded.add("desktop");
        } else failed.push({ channel: "dashboard", error: "no dashboard was open" });
      } catch (e) {
        (started ? unknown : failed).push({ channel: "dashboard", error: errorMessage(e) });
      }
    }

    // M8 channels (telegram, discord, signal, etc.)
    const m8Channels = Array.from(expanded).filter((c) => c !== "dashboard" && c !== "voice" && c !== "desktop");
    if (m8Channels.length > 0) {
      let started = false;
      try {
        checkpointExecution();
        started = true;
        const report = await this.deps.broadcastToChannels(m8Channels, input.message);
        for (const d of report.delivered) delivered.push(d);
        for (const f of report.failed) failed.push(f);
        for (const u of report.unknown ?? []) unknown.push(u);
      } catch (e) {
        // The router reports each channel itself. If it threw anyway, any of
        // them may already have sent: never report those as not sent.
        for (const c of m8Channels) (started ? unknown : failed).push({ channel: c, error: errorMessage(e) });
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
        await this.surface("voice", () => this.deps.sendVoice!(input.message),
          "nothing was spoken: no dashboard was open to play it", { delivered, failed, unknown });
      }
    }

    // Desktop
    if (expanded.has("desktop")) {
      if (!this.deps.sendDesktop) {
        failed.push({ channel: "desktop", error: "desktop notifications not available on this platform" });
      } else {
        await this.surface("desktop", () => this.deps.sendDesktop!(titleForPriority(priority), input.message),
          "the desktop did not show it", { delivered, failed, unknown });
      }
    }

    // A skipped dashboard is reported only when nothing reached anyone: then
    // it is part of why the message was not sent.
    if (delivered.length === 0 && unknown.length === 0) failed.unshift(...skipped);
    return { delivered, failed, unknown };
  }

  /**
   * One local surface. Refused before it started: failed. Started and then
   * threw, or did not confirm in time: it may already have shown or played
   * part of it, so unknown.
   */
  private async surface(channel: string, send: () => Promise<boolean | "unknown">, notShown: string,
    report: Required<NotifierBroadcastReport>): Promise<void> {
    try {
      checkpointExecution();
    } catch (e) {
      report.failed.push({ channel, error: errorMessage(e) });
      return;
    }
    try {
      const shown = await send();
      if (shown === "unknown") report.unknown.push({ channel, error: "it did not confirm in time; it may have shown" });
      else if (shown) report.delivered.push(channel);
      else report.failed.push({ channel, error: notShown });
    } catch (e) {
      report.unknown.push({ channel, error: errorMessage(e) });
    }
  }
}

function expandChannels(requested: PieceNotifyChannel[], deps: NotifierDeps): Set<string> {
  const out = new Set<string>();
  for (const c of requested) {
    if (c === "auto") {
      // Dashboard always (the in-app surface; with no dashboard open it is
      // skipped and the desktop tried, Q-19). For external channels we consult the dep, when wired, to
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
