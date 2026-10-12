import {
  queryString,
  validPage,
  type MemoryPort,
  type MemoryRead,
} from "./model";

/** Construct only after authenticated F17/F18 integration. Never registered by default. */
export function memoryHttpPort(
  scopeId: string,
  request: typeof fetch = fetch,
): MemoryPort {
  return {
    source: "live",
    scopeId,
    async read(query, signal): Promise<MemoryRead> {
      const response = await request(
        `/api/brief/memory?${queryString(query)}`,
        {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal,
          headers: { Accept: "application/json" },
        },
      );
      if (response.status === 401 || response.status === 403)
        return {
          state: "unavailable",
          reason: "Memory access is unavailable. Sign in again.",
        };
      if (response.status === 404 || response.status === 501)
        return {
          state: "unsupported",
          reason: "Memory search is not available on this brain.",
        };
      if (response.status === 409)
        return {
          state: "stale",
          reason:
            "Memory changed or this search expired. Refresh to read current facts.",
        };
      if (response.status === 503)
        return {
          state: "unavailable",
          reason:
            "Memory search or recorded usage is unavailable. Try refreshing later.",
        };
      if (!response.ok)
        return {
          state: "error",
          reason: "Memory could not be loaded. Check the filters and retry.",
        };
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("state" in body) ||
        !("data" in body) ||
        !("asOf" in body) ||
        !["ready", "empty"].includes(String(body.state)) ||
        !Number.isSafeInteger(body.asOf) ||
        !validPage(body.data, query) ||
        (body.state === "empty") !== (body.data.count.matched === 0)
      )
        return {
          state: "error",
          reason:
            "The memory response could not be verified. Retry the search.",
        };
      return body as MemoryRead;
    },
  };
}
