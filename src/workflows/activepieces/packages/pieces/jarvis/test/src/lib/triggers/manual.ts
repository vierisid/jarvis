/**
 * `manual` trigger: a no-op trigger whose `run` returns `[propsValue.payload]`
 * exactly as configured. This lets us start engine-driven flows in tests
 * without registering webhooks, scheduling cron jobs, or subscribing to the
 * event bus.
 *
 * The engine's BEGIN flow path requires a `PIECE_TRIGGER` (it casts every
 * trigger to `PieceTrigger` and reads triggerName); this trigger satisfies
 * that contract while doing nothing more.
 */

import {
  createTrigger,
  Property,
  TriggerStrategy,
} from "@activepieces/pieces-framework";

export const manualTrigger = createTrigger({
  name: "manual",
  displayName: "Manual",
  description: "Returns the configured payload as the trigger output.",
  type: TriggerStrategy.WEBHOOK,
  props: {
    payload: Property.Json({
      displayName: "Payload",
      description: "JSON returned as the trigger output.",
      required: false,
    }),
  },
  sampleData: null,
  async onEnable() {
    // no-op
  },
  async onDisable() {
    // no-op
  },
  async run(context) {
    const payload = (context.propsValue["payload"] as unknown) ?? {};
    return [payload];
  },
});
