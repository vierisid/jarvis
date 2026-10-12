import { createAuthorityPort, type AuthorityHost } from "./adapter";
import { AuthorityController } from "./controller";
import type { AuthorityDestination, AuthoritySettings } from "./model";

export const AUTHORITY_SCOPE = "d28-isolated-fixture";
export const AUTHORITY_EXAMPLES = [
  "ready",
  "read-only",
  "save-failure",
  "lost-response",
  "conflict",
  "paused",
  "killed",
  "unavailable",
  "error",
  "unsupported",
] as const;
export type AuthorityExample = (typeof AUTHORITY_EXAMPLES)[number];
export function makeAuthorityFixture(
  example: AuthorityExample = "ready",
  delay = 0,
) {
  let config: AuthoritySettings = {
    default_level: 3,
    governed_categories: ["send_message", "send_email", "make_payment"],
    emergency_state:
      example === "paused"
        ? "paused"
        : example === "killed"
          ? "killed"
          : "normal",
  };
  let readError = false;
  const writes: unknown[] = [],
    navigations: AuthorityDestination[] = [];
  const host: AuthorityHost = {
    canWrite: example !== "read-only",
    destinations: { "advanced-authority": true, "emergency-controls": true },
    async request(_path, init) {
      await new Promise((r) => setTimeout(r, delay));
      if (init.signal?.aborted) throw Error("Canceled");
      if (example === "unavailable") return new Response(null, { status: 403 });
      if (example === "unsupported") return new Response(null, { status: 404 });
      if (example === "error" || readError)
        return new Response(null, { status: 503 });
      if (init.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        if (example === "save-failure")
          return new Response(null, { status: 500 });
        config = { ...config, ...JSON.parse(String(init.body)) };
        if (example === "lost-response") throw Error("Lost acknowledgment");
        return Response.json({ ok: true, config });
      }
      return Response.json(config);
    },
    async navigate(destination, signal) {
      await new Promise((r) => setTimeout(r, delay));
      if (signal.aborted) return { state: "unavailable" };
      navigations.push(destination);
      return { state: "opened" };
    },
  };
  const port = {
    ...createAuthorityPort(AUTHORITY_SCOPE, host),
    source: "fixture" as const,
  };
  if (example === "conflict") {
    const save = port.save;
    port.save = async (...args) => {
      config.default_level = args[0].default_level === 10 ? 1 : 10;
      return save(...args);
    };
  }
  return {
    port,
    host,
    controller: new AuthorityController(port),
    writes,
    navigations,
    current: () => structuredClone(config),
    change: (patch: Partial<AuthoritySettings>) => {
      config = { ...config, ...patch };
    },
    failReads: (value: boolean) => {
      readError = value;
    },
  };
}
