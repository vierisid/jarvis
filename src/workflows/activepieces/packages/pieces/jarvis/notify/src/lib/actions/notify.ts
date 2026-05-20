/**
 * `notify` action -- POST `{ message, channels?, priority? }` to
 * `/v1/jarvis/notify` and surface the delivery report.
 *
 * Channel routing is owned by the daemon-side notifier (`auto` expansion,
 * fan-out across telegram/discord/dashboard/desktop/voice, partial-failure
 * reporting). The piece is intentionally thin: it forwards user input
 * verbatim and delegates validation to the route handler. The
 * `StaticMultiSelectDropdown`/`StaticDropdown` widgets already restrict
 * values to the allow-list at compose time, so the piece doesn't duplicate
 * a runtime allow-list check.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

interface NotifyResponse {
  delivered: string[];
  failed: { channel: string; error: string }[];
}

export const notifyAction = createAction({
  name: "notify",
  displayName: "Send a Jarvis notification",
  description:
    "Deliver a message through Jarvis's configured channels. Use 'auto' to let Jarvis pick a sensible default given the priority.",
  // Delivery report: `delivered` lists channel names the notifier
  // actually reached; `failed` carries one entry per channel that
  // refused, with the error string for diagnostics. Both are always
  // present in the response (empty arrays on full success / failure).
  outputSample: {
    delivered: ["telegram", "dashboard"],
    failed: [
      { channel: "discord", error: "no recipient configured" },
    ],
  },
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
    const body: Record<string, unknown> = { message };
    const channels = context.propsValue["channels"];
    if (Array.isArray(channels) && channels.length > 0) body["channels"] = channels;
    const priority = context.propsValue["priority"];
    if (typeof priority === "string" && priority.length > 0) body["priority"] = priority;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.server.token}`,
      },
      body: JSON.stringify(body),
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

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
