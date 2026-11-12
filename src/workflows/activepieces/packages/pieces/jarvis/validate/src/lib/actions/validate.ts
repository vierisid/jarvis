/**
 * `validate` action -- proves the connection's `access_token` reached the
 * piece (by a fingerprint, never the token itself: step output is kept in run
 * history) and round-trips a value through `context.store`. The Phase L smoke
 * test asserts both to prove the engine's connection-resolver + store paths
 * work end-to-end.
 */

import { createHash } from "node:crypto";
import { createAction, Property } from "@activepieces/pieces-framework";

const STORE_KEY = "jarvis-validate:roundtrip";

export const validateAction = createAction({
  name: "validate",
  displayName: "Validate plumbing",
  description: "Read connection auth + round-trip a value through context.store.",
  // Plumbing-smoke action: the response is always these keys.
  // `accessToken` is null when the connection has no `access_token`
  // claim, and "[redacted]" otherwise; `storeReadBack` should equal `storeValue` on a clean
  // round-trip (the assertion the test relies on).
  outputSample: {
    accessToken: "[redacted]",
    accessTokenFingerprint: "0123456789abcdef",
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
      // The key stays for workflows that read it, but a credential is never
      // written into step output: it is shown as present or absent, and
      // `accessTokenFingerprint` (the first 16 hex characters of its SHA-256)
      // lets a test prove which token arrived.
      accessToken: token === null ? null : "[redacted]",
      accessTokenFingerprint: token === null ? null : createHash("sha256").update(token).digest("hex").slice(0, 16),
      storeValue,
      storeReadBack: readBack,
      projectId: context.project?.id ?? null,
    };
  },
});
