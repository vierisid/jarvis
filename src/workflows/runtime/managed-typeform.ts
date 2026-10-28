/** Read-only fixed endpoints. Provider replies and errors are bounded; no automatic retries. */
export const MANAGED_TYPEFORM_ACTIONS = [
  "list_workspaces",
  "list_forms",
  "get_form",
  "list_responses",
] as const;
export function managedTypeformInput(
  input: unknown,
): Record<string, unknown> | null {
  return (input as { auth?: { jarvis_managed?: unknown } } | null)?.auth
    ?.jarvis_managed === "typeform"
    ? (input as Record<string, unknown>)
    : null;
}
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const provided = (v: unknown) => v !== undefined && v !== null && v !== "";
function text(v: unknown, label: string, max = 512): string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error("Enter a valid " + label + ".");
  return v.trim();
}
function id(v: unknown): string {
  const s = text(v, "Typeform ID", 256);
  if (!/^[A-Za-z0-9_-]+$/.test(s))
    throw new Error("Enter a valid Typeform ID.");
  return s;
}
function integer(v: unknown, fallback: number, max: number): number {
  if (!provided(v)) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max)
    throw new Error("Enter a valid Typeform page or page size.");
  return v;
}
function choice(v: unknown, allowed: string[]): string {
  if (typeof v !== "string" || !allowed.includes(v))
    throw new Error("Choose a supported Typeform option.");
  return v;
}
export async function runManagedTypeformAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_TYPEFORM_ACTIONS as readonly string[]).includes(action))
    throw new Error(
      "This Typeform action has not been enabled for the managed connection.",
    );
  if (
    !record(input.auth) ||
    typeof input.auth.access_token !== "string" ||
    !input.auth.access_token
  )
    throw new Error("Reconnect Typeform.");
  let path: string;
  const query = new URLSearchParams();
  if (action === "get_form") path = "/forms/" + id(input.form_id);
  else if (action === "list_responses") {
    path = "/forms/" + id(input.form_id) + "/responses";
    query.set("page_size", String(integer(input.pageSize, 25, 1000)));
    for (const key of ["query", "before", "after"] as const)
      if (provided(input[key]))
        query.set(
          key,
          key === "query" ? text(input[key], "search") : id(input[key]),
        );
    if (provided(input.before) && provided(input.after))
      throw new Error("Use one response pagination cursor at a time.");
    for (const key of ["since", "until"] as const)
      if (provided(input[key])) {
        const value = text(input[key], "submission date", 64);
        if (!Number.isFinite(Date.parse(value)))
          throw new Error("Enter a valid submission date.");
        query.set(key, value);
      }
    if (
      provided(input.since) &&
      provided(input.until) &&
      Date.parse(String(input.since)) > Date.parse(String(input.until))
    )
      throw new Error("Submitted After must precede Submitted Before.");
    if (provided(input.responseType))
      query.set(
        "response_type",
        choice(input.responseType, ["completed", "partial", "started"]),
      );
    if (provided(input.sort))
      query.set(
        "sort",
        choice(input.sort, ["submitted_at,asc", "submitted_at,desc"]),
      );
    if (provided(input.includedResponseIds)) {
      if (
        !Array.isArray(input.includedResponseIds) ||
        input.includedResponseIds.length > 1000
      )
        throw new Error("Enter a list of response IDs.");
      if (input.includedResponseIds.length)
        query.set(
          "included_response_ids",
          input.includedResponseIds.map(id).join(","),
        );
    }
  } else {
    path =
      action === "list_forms"
        ? "/forms"
        : provided(input.accountId)
          ? "/accounts/" + id(input.accountId) + "/workspaces"
          : "/workspaces";
    query.set("page", String(integer(input.page, 1, 10000)));
    query.set("page_size", String(integer(input.pageSize, 25, 200)));
    if (provided(input.search))
      query.set("search", text(input.search, "search"));
    if (action === "list_forms") {
      if (provided(input.workspace))
        query.set("workspace_id", id(input.workspace));
      if (provided(input.sortBy))
        query.set(
          "sort_by",
          choice(input.sortBy, ["created_at", "last_updated_at"]),
        );
      if (provided(input.orderBy))
        query.set("order_by", choice(input.orderBy, ["asc", "desc"]));
    }
  }
  let host = "api.typeform.com";
  if (action === "list_responses") {
    // Responses can live in the legacy EU data center even for a .com OAuth account.
    const form = (await runManagedTypeformAction(
      "get_form",
      { auth: input.auth, form_id: input.form_id },
      request,
    )) as Record<string, any>;
    let location: URL;
    try {
      location = new URL(form._links.responses);
    } catch {
      throw new Error("Typeform did not identify this form's response region.");
    }
    if (
      !["api.typeform.com", "api.eu.typeform.com"].includes(location.host) ||
      location.protocol !== "https:" ||
      location.username ||
      location.password ||
      location.search ||
      location.hash ||
      location.pathname !== path
    )
      throw new Error(
        "This Typeform response region is not supported by this connection.",
      );
    host = location.hostname;
  }
  let response: Response;
  try {
    response = await request(
      "https://" + host + path + (query.size ? "?" + query : ""),
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: "Bearer " + input.auth.access_token,
          Accept: "application/json",
        },
      },
    );
  } catch {
    throw new Error("Typeform could not be reached. Try again shortly.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? "Typeform refused access. Reconnect Typeform."
        : response.status === 429
          ? "Typeform is rate limiting requests. Try again later."
          : "Typeform could not read this resource. Check the ID and account permissions.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Typeform returned an empty response.");
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) throw new Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(result)) throw new Error();
    if (action === "get_form") {
      if (
        typeof result.id !== "string" ||
        result.id !== input.form_id ||
        typeof result.title !== "string"
      )
        throw new Error();
    } else if (
      !Array.isArray(result.items) ||
      !Number.isInteger(result.total_items) ||
      result.total_items < 0 ||
      !Number.isInteger(result.page_count) ||
      result.page_count < 0 ||
      result.items.some((v: unknown) => !record(v))
    )
      throw new Error();
    return result;
  } catch {
    throw new Error(
      "Typeform returned an invalid or oversized response. Try a smaller page.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
