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
import { sendNotification } from './send-notification';

export const notifyAction = createAction({
  name: "notify",
  displayName: "Send a Jarvis notification",
  description:
    "Deliver a message through Jarvis's configured channels. Use 'auto' to let Jarvis pick a sensible default given the priority.",
  // Delivery report: `delivered` lists channel names the notifier
  // actually reached; `failed` carries one entry per channel that did not
  // send it, with the error string for diagnostics; `unknown` lists channels
  // that may have taken it without confirming (a timeout after sending), which
  // Jarvis never resends on its own. All three are always present. The step
  // fails only when nothing was sent on any channel.
  outputSample: {
    delivered: ["telegram", "dashboard"],
    failed: [
      { channel: "discord", error: "no recipient configured" },
    ],
    unknown: [],
  },
  props: {
    meetingGuard: Property.Json({ displayName: 'Meeting freshness guard', required: false,
      description: 'For meeting briefs, pass {{loop.item.guard}} from Context: Prepare upcoming external meeting briefs. Rechecks the current event after approval, suppresses changed/cancelled/past meetings, and derives the persistent event/start key in the daemon. Requires dashboard-only delivery.' }),
    idempotencyKey: Property.ShortText({ displayName: 'Notification identity', required: false,
      description: 'Optional stable identity, e.g. qualified-contact:{{upsert.id}}. Consumed once per workflow across runs, versions and branches. Repeated keys suppress delivery; uncertain delivery requires review. Use a different explicit key only for a genuinely new notification.' }),
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
  async run(context) { return sendNotification(context); },
});
