/** Regional Wrike API v4 adapter. Writes are sent once and never implicitly retried. */
import { wrikeInputSchema } from "./managed-wrike-inputs";
export const MANAGED_WRIKE_ACTIONS = [
  "find_task",
  "create_task",
  "update_task",
  "add_comment",
] as const;
const hosts = ["www.wrike.com", "app-us2.wrike.com", "app-eu.wrike.com"];
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== null && v !== "";
export function wrikeId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v))
    throw Error("Enter a valid Wrike API ID or workflow variable.");
  return v;
}
function text(
  v: unknown,
  label: string,
  max: number,
  multiline = false,
): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(v)
  )
    throw Error("Enter a valid Wrike " + label + ".");
  return v;
}
export function managedWrikeInput(
  input: unknown,
): Record<string, unknown> | null {
  return object(input) &&
    object(input.auth) &&
    input.auth.jarvis_managed === "wrike"
    ? input
    : null;
}
export async function runManagedWrikeAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const schema = wrikeInputSchema(action);
  if (!schema)
    throw Error("This Wrike action is not enabled for the managed connection.");
  if (
    !object(input.auth) ||
    !hosts.includes(input.auth.api_host) ||
    typeof input.auth.access_token !== "string" ||
    !input.auth.access_token ||
    input.auth.access_token.length > 16384
  )
    throw Error("Reconnect Wrike.");
  const allowed = new Set(["auth", ...schema.fields.map((f) => f.name)]);
  for (const [key, value] of Object.entries(input))
    if (
      !allowed.has(key) &&
      present(value) &&
      !(Array.isArray(value) && !value.length)
    )
      throw Error(
        "This managed Wrike action does not support " +
          key +
          ". Remove that field before running.",
      );
  const params = new URLSearchParams();
  let path: string,
    method = "GET",
    expectedId: string | undefined,
    kind = "tasks";
  if (action === "add_comment") {
    if (input.entityType !== "tasks" && input.entityType !== "folders")
      throw Error("Choose a task or folder for the comment.");
    path = "/" + input.entityType + "/" + wrikeId(input.entityId) + "/comments";
    params.set("text", text(input.text, "comment", 10000, true));
    if (present(input.plainText) && typeof input.plainText !== "boolean")
      throw Error("Choose whether the Wrike comment is plain text.");
    params.set("plainText", String(input.plainText ?? true));
    method = "POST";
    kind = "comments";
  } else {
    if (present(input.title))
      params.set("title", text(input.title, "title", 1000));
    for (const [key, values] of [
      ["status", ["Active", "Completed", "Deferred", "Cancelled"]],
      ["importance", ["Low", "Normal", "High"]],
    ] as const) {
      if (present(input[key])) {
        if (!values.includes(input[key] as never))
          throw Error("Choose a valid Wrike " + key + ".");
        params.set(
          key,
          action === "find_task" && key === "status"
            ? JSON.stringify([input[key]])
            : String(input[key]),
        );
      }
    }
    if (action === "find_task") {
      if (present(input.taskId)) {
        if (
          Object.entries(input).some(
            ([k, v]) =>
              k !== "auth" &&
              k !== "taskId" &&
              !(k === "pageSize" && v === 100) &&
              present(v),
          )
        )
          throw Error("Use either a task ID or search filters, not both.");
        expectedId = wrikeId(input.taskId);
        path = "/tasks/" + expectedId;
      } else {
        path = present(input.folderId)
          ? "/folders/" + wrikeId(input.folderId) + "/tasks"
          : "/tasks";
        const size = present(input.pageSize) ? input.pageSize : 100;
        if (
          typeof size !== "number" ||
          !Number.isInteger(size) ||
          size < 1 ||
          size > 100
        )
          throw Error("Choose a page size from 1 to 100.");
        params.set("pageSize", String(size));
        if (present(input.nextPageToken))
          params.set(
            "nextPageToken",
            text(input.nextPageToken, "page token", 4096),
          );
      }
    } else {
      if (present(input.description))
        params.set(
          "description",
          text(input.description, "description", 20000, true),
        );
      if (action === "create_task") {
        params.set("title", text(input.title, "title", 1000));
        path = "/folders/" + wrikeId(input.folderId) + "/tasks";
        method = "POST";
      } else {
        expectedId = wrikeId(input.taskId);
        path = "/tasks/" + expectedId;
        method = "PUT";
        if (!params.size)
          throw Error(
            "Choose at least one field to update. Empty fields preserve existing values.",
          );
      }
    }
  }
  return wrikeRequest(
    input.auth,
    path,
    method,
    params,
    kind,
    expectedId,
    request,
  );
}
async function wrikeRequest(
  auth: Record<string, any>,
  path: string,
  method: string,
  params: URLSearchParams,
  kind: string,
  expectedId: string | undefined,
  request: typeof fetch,
): Promise<any> {
  if (
    !hosts.includes(auth.api_host) ||
    typeof auth.access_token !== "string" ||
    !auth.access_token
  )
    throw Error("Reconnect Wrike.");
  const writing = method !== "GET";
  let response: Response;
  try {
    response = await request(
      "https://" +
        auth.api_host +
        "/api/v4" +
        path +
        (!writing && params.size ? "?" + params : ""),
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: "Bearer " + auth.access_token,
          Accept: "application/json",
          ...(writing
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(writing ? { body: params.toString() } : {}),
      },
    );
  } catch {
    throw Error(
      writing
        ? "Wrike's result is uncertain. Check the task or comment before trying again."
        : "Wrike could not be reached. Try again shortly.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Error(
      response.status === 401
        ? "Wrike refused access. Reconnect Wrike."
        : response.status === 429
          ? "Wrike is rate limiting requests. Try again later."
          : "Wrike refused this request. Check access and the target before retrying.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw Error(
      "Wrike returned an empty response. Check the target before retrying.",
    );
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) throw Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !object(data) ||
      data.error ||
      data.kind !== kind ||
      !Array.isArray(data.data) ||
      data.data.length > 100 ||
      ((writing || expectedId) && data.data.length !== 1)
    )
      throw Error();
    for (const row of data.data) {
      if (!object(row)) throw Error();
      wrikeId(row.id);
      if (
        (kind === "tasks" || kind === "folders") &&
        typeof row.title !== "string"
      )
        throw Error();
      if (kind === "comments" && typeof row.text !== "string") throw Error();
      if (expectedId && row.id !== expectedId) throw Error();
    }
    if (data.nextPageToken !== undefined)
      text(data.nextPageToken, "page token", 4096);
    return data;
  } catch {
    throw Error(
      "Wrike returned an invalid response. Check the task or comment before trying again.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A bounded folder search used by the editor, using the account's refreshed regional grant. */
export async function wrikeFolderPage(
  auth: Record<string, any>,
  title: string,
  cursor: string | null,
  request: typeof fetch = fetch,
) {
  const params = new URLSearchParams({
    title: text(title, "folder title", 200),
    descendants: "true",
    deleted: "false",
    pageSize: "100",
  });
  if (cursor) params.set("nextPageToken", text(cursor, "page token", 4096));
  const data = await wrikeRequest(
    auth,
    "/folders",
    "GET",
    params,
    "folders",
    undefined,
    request,
  );
  return {
    options: data.data.map((v: any) => ({
      value: v.id,
      label: v.title.slice(0, 200) + " (" + v.id + ")",
    })),
    next_cursor: data.nextPageToken ?? null,
  };
}
