/**
 * `validate` action -- echoes back the connection's `access_token` and
 * round-trips a value through `context.store`. The Phase L smoke test
 * asserts both surface to prove the engine's connection-resolver + store
 * paths work end-to-end.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

const STORE_KEY = "jarvis-validate:roundtrip";

export const validateAction = createAction({
  name: "validate",
  displayName: "Validate plumbing",
  description: "Read connection auth + round-trip a value through context.store.",
  // Plumbing-smoke action: the response is always these four keys.
  // `accessToken` is null when the connection has no `access_token`
  // claim; `storeReadBack` should equal `storeValue` on a clean
  // round-trip (the assertion the test relies on).
  outputSample: {
    accessToken: "redacted-bearer-token-string",
    storeValue: "ping",
    storeReadBack: "ping",
    projectId: "DEFAULT_PROJECT",
  },
  props: {
    storeValue: Property.ShortText({
      displayName: "Value to write/read via context.store",
      required: true,
    }),
  },
  async run(context) {
    const auth = (context.auth ?? {}) as { access_token?: string };
    const token = typeof auth.access_token === "string" ? auth.access_token : null;

    const storeValue = context.propsValue["storeValue"];
    if (typeof storeValue !== "string") {
      throw new Error("jarvis-validate: storeValue must be a string");
    }
    await context.store.put(STORE_KEY, storeValue);
    const readBack = await context.store.get(STORE_KEY);

    return {
      accessToken: token,
      storeValue,
      storeReadBack: readBack,
      projectId: context.project?.id ?? null,
    };
  },
});
