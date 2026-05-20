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
  // The wrapper key is always `echo`. The inner value is whatever the
  // user passed in -- we put a representative string here so the
  // picker has something concrete to label the row.
  outputSample: {
    echo: "hello world",
  },
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
