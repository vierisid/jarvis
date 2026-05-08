/**
 * `notify` action -- POST `{ message, channels?, priority? }` to
 * `/v1/jarvis/notify` and surface the delivery report.
 *
 * `channels` defaults to `["auto"]` (let the daemon pick reasonable
 * defaults). Pieces never throw on partial-channel failure; the daemon's
 * route returns `{ delivered, failed }` and downstream nodes branch on it.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

const VALID_CHANNELS = ["auto", "dashboard", "telegram", "discord", "voice", "desktop"] as const;
const VALID_PRIORITIES = ["low", "normal", "high"] as const;

interface NotifyResponse {
  delivered: string[];
  failed: { channel: string; error: string }[];
}

export const notifyAction = createAction({
  name: "notify",
  displayName: "Send a Jarvis notification",
  description:
    "Deliver a message through Jarvis's configured channels. Use 'auto' to let Jarvis pick a sensible default given the priority.",
  props: {
    message: Property.LongText({
      displayName: "Message",
      description:
        "Body of the notification. Supports {{stepName.field}} templates resolved by the engine.",
      required: true,
    }),
    channels: Property.StaticMultiSelectDropdown({
      displayName: "Channels",
      description:
        "Empty / [auto] lets Jarvis pick a default fan-out across the user's connected channels.",
      required: false,
      defaultValue: ["auto"],
      options: {
        disabled: false,
        options: [
          { value: "auto", label: "Auto (recommended)" },
          { value: "dashboard", label: "Dashboard" },
          { value: "telegram", label: "Telegram" },
          { value: "discord", label: "Discord" },
          { value: "voice", label: "Voice (TTS)" },
          { value: "desktop", label: "Desktop notification" },
        ],
      },
    }),
    priority: Property.StaticDropdown({
      displayName: "Priority",
      required: false,
      defaultValue: "normal",
      options: {
        disabled: false,
        options: [
          { value: "low", label: "Low" },
          { value: "normal", label: "Normal" },
          { value: "high", label: "High (urgent)" },
        ],
      },
    }),
  },
  async run(context) {
    const url = trimSlash(context.server.apiUrl) + "/v1/jarvis/notify";
    const message = context.propsValue["message"];
    if (typeof message !== "string" || message.length === 0) {
      throw new Error("jarvis-notify: message is required and must be a non-empty string");
    }
    const rawChannels = context.propsValue["channels"];
    const channels = normalizeChannels(rawChannels);
    const rawPriority = context.propsValue["priority"];
    const priority = normalizePriority(rawPriority);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.server.token}`,
      },
      body: JSON.stringify({ message, channels, priority }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `jarvis-notify: daemon responded ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return (await response.json()) as NotifyResponse;
  },
});

function normalizeChannels(raw: unknown): string[] {
  if (raw === undefined || raw === null) return ["auto"];
  if (!Array.isArray(raw) || raw.length === 0) return ["auto"];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== "string" || !(VALID_CHANNELS as readonly string[]).includes(c)) {
      throw new Error(
        `jarvis-notify: channels[] must contain only: ${VALID_CHANNELS.join(", ")}`,
      );
    }
    out.push(c);
  }
  return out;
}

function normalizePriority(raw: unknown): string {
  if (raw === undefined || raw === null) return "normal";
  if (typeof raw !== "string" || !(VALID_PRIORITIES as readonly string[]).includes(raw)) {
    throw new Error(
      `jarvis-notify: priority must be one of: ${VALID_PRIORITIES.join(", ")}`,
    );
  }
  return raw;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
