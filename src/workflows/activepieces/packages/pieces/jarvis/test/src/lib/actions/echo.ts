/**
 * `echo` action: returns its propsValue verbatim. Used by tests to verify
 * that the engine's flow-executor walks past the trigger and runs at least
 * one action successfully.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

export const echoAction = createAction({
  name: "echo",
  displayName: "Echo",
  description: "Returns the input value verbatim.",
  props: {
    value: Property.Json({
      displayName: "Value",
      description: "Returned as-is in the step output.",
      required: false,
    }),
  },
  async run(context) {
    return { echo: context.propsValue["value"] ?? null };
  },
});
