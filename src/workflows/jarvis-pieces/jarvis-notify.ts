/**
 * `jarvis-notify` piece -- channel-aware delivery. Hands off to the daemon's
 * `PieceNotifier` (a thin facade over M8 channels + dashboard broadcaster +
 * voice). The piece does not pick recipients or route -- that's the
 * notifier's job. This file's only responsibility is input validation.
 *
 * Action: notify
 *   message:  string                                   (required, non-empty)
 *   channels: PieceNotifyChannel[]                     (default ["auto"])
 *   priority: "low" | "normal" | "high"                (default "normal")
 */

import {
  JarvisActionInputError,
  type JarvisAction,
  type JarvisPiece,
  type JarvisPieceContext,
  type PieceNotifyChannel,
  type PieceNotifyInput,
  type PieceNotifyPriority,
  type PieceNotifyResult,
} from "./types";

const VALID_CHANNELS = new Set<PieceNotifyChannel>([
  "auto",
  "telegram",
  "discord",
  "voice",
  "dashboard",
  "desktop",
]);

const VALID_PRIORITIES = new Set<PieceNotifyPriority>(["low", "normal", "high"]);

export interface NotifyInput {
  message: string;
  channels: PieceNotifyChannel[];
  priority: PieceNotifyPriority;
}

export interface NotifyOutput {
  delivered: string[];
  failed: { channel: string; error: string }[];
}

export const notifyAction: JarvisAction<NotifyInput, NotifyOutput> = {
  name: "notify",
  displayName: "Send a Jarvis notification",
  description:
    "Deliver a message through the user's configured channels (Telegram/Discord/voice/dashboard/desktop). Use 'auto' to let Jarvis pick a sensible default for the current priority.",

  inputSchema: {
    fields: [
      {
        name: "message",
        label: "Message",
        type: "long_text",
        required: true,
        description: "Body of the notification. Supports {{stepName.field}} templates.",
      },
      {
        name: "channels",
        label: "Channels",
        type: "multi_enum",
        required: false,
        default: ["auto"],
        description: "Empty / [auto] lets Jarvis pick a default fan-out.",
        options: [
          { value: "auto", label: "Auto (recommended)" },
          { value: "dashboard", label: "Dashboard" },
          { value: "telegram", label: "Telegram" },
          { value: "discord", label: "Discord" },
          { value: "voice", label: "Voice (TTS)" },
          { value: "desktop", label: "Desktop notification" },
        ],
      },
      {
        name: "priority",
        label: "Priority",
        type: "enum",
        required: false,
        default: "normal",
        options: [
          { value: "low", label: "Low" },
          { value: "normal", label: "Normal" },
          { value: "high", label: "High (urgent)" },
        ],
      },
    ],
  },

  parseInput: (raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new JarvisActionInputError("input must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.message !== "string" || r.message.length === 0) {
      throw new JarvisActionInputError("message is required and must be a non-empty string");
    }
    let channels: PieceNotifyChannel[] = ["auto"];
    if (r.channels !== undefined) {
      if (!Array.isArray(r.channels)) {
        throw new JarvisActionInputError("channels must be an array if provided");
      }
      const list: PieceNotifyChannel[] = [];
      for (const c of r.channels) {
        if (typeof c !== "string" || !VALID_CHANNELS.has(c as PieceNotifyChannel)) {
          throw new JarvisActionInputError(
            `channels[] must contain only: ${Array.from(VALID_CHANNELS).join(", ")}`,
          );
        }
        list.push(c as PieceNotifyChannel);
      }
      // Tolerate empty array as "auto" (caller asked for "no specific channels").
      channels = list.length > 0 ? list : ["auto"];
    }
    let priority: PieceNotifyPriority = "normal";
    if (r.priority !== undefined) {
      if (typeof r.priority !== "string" || !VALID_PRIORITIES.has(r.priority as PieceNotifyPriority)) {
        throw new JarvisActionInputError("priority must be 'low', 'normal', or 'high'");
      }
      priority = r.priority as PieceNotifyPriority;
    }
    return { message: r.message, channels, priority };
  },

  async execute(input, ctx: JarvisPieceContext): Promise<NotifyOutput> {
    const notifier = ctx.services.notifier;
    if (!notifier) {
      throw new Error("jarvis-notify: ctx.services.notifier is not configured");
    }
    const notifierInput: PieceNotifyInput = {
      message: input.message,
      channels: input.channels,
      priority: input.priority,
    };
    const result: PieceNotifyResult = await notifier.notify(notifierInput);
    return { delivered: result.delivered, failed: result.failed };
  },
};

export const jarvisNotifyPiece: JarvisPiece = {
  name: "jarvis-notify",
  displayName: "Jarvis: Notify",
  description:
    "Deliver a message to the user via the configured channels (Telegram, Discord, voice, dashboard, desktop). Cleaner than calling individual chat-piece nodes per channel.",
  actions: {
    [notifyAction.name]: notifyAction as unknown as JarvisAction,
  },
};
