/** Fetch-only adapter for the four qualified managed actions. Manual PAT connections retain upstream behaviour. */
export const MANAGED_AIRTABLE_ACTIONS = [
  "create_record_ai",
  "search_records",
  "update_record_ai",
  "get_record",
] as const;
export const airtableId = (value: unknown, prefix: string) =>
  typeof value === "string" &&
  new RegExp("^" + prefix + "[a-zA-Z0-9]{14}$").test(value);
export function managedAirtableInput(
  input: unknown,
): Record<string, unknown> | null {
  return (input as { auth?: { jarvis_managed?: unknown } } | null)?.auth
    ?.jarvis_managed === "airtable"
    ? (input as Record<string, unknown>)
    : null;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function airtableFields(value: unknown): Record<string, unknown> | null {
  try {
    const fields = typeof value === "string" ? JSON.parse(value) : value;
    return object(fields) &&
      Object.keys(fields).length > 0 &&
      Object.keys(fields).length <= 100 &&
      JSON.stringify(fields).length <= 65536
      ? fields
      : null;
  } catch {
    return null;
  }
}
export function managedAirtableIssue(
  action: unknown,
  input: Record<string, unknown>,
  resolved = true,
): string | null {
  if (!(MANAGED_AIRTABLE_ACTIONS as readonly unknown[]).includes(action))
    return "This Airtable connection supports Find, Get, Create and Update Record. Other actions and triggers are not enabled.";
  const dynamic = (v: unknown) =>
    !resolved && typeof v === "string" && v.includes("{{");
  for (const [key, prefix] of [
    ["base_id", "app"],
    ["table_id_or_name", "tbl"],
    ...(["get_record", "update_record_ai"].includes(String(action))
      ? [["record_id", "rec"]]
      : []),
  ]) {
    if (!dynamic(input[key!]) && !airtableId(input[key!], prefix!))
      return "Choose a valid Airtable " + key + " or a workflow variable.";
  }
  if (action === "search_records") {
    if (!dynamic(input.search_field) && !airtableId(input.search_field, "fld"))
      return "Choose a search field from the selected table.";
    if (
      !dynamic(input.search_value) &&
      (typeof input.search_value !== "string" ||
        !input.search_value ||
        input.search_value.length > 4096)
    )
      return "Enter search text, up to 4,096 characters.";
    if (
      input.match_mode &&
      !dynamic(input.match_mode) &&
      !["contains", "exact"].includes(String(input.match_mode))
    )
      return "Choose Contains or Exact match.";
    if (
      input.max_records != null &&
      !dynamic(input.max_records) &&
      (!Number.isInteger(input.max_records) ||
        Number(input.max_records) < 1 ||
        Number(input.max_records) > 1000)
    )
      return "Max Records must be between 1 and 1,000.";
    if (input.view && !dynamic(input.view) && !airtableId(input.view, "viw"))
      return "Enter a valid Airtable view ID or leave View empty.";
  }
  if (
    ["create_record_ai", "update_record_ai"].includes(String(action)) &&
    !dynamic(input.fields) &&
    !airtableFields(input.fields)
  )
    return "Enter a JSON object with 1 to 100 existing field IDs or names and their values (up to 64 KiB).";
  return null;
}
export class AirtableRequestError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
export async function airtableJson(
  path: string,
  token: string,
  init: RequestInit = {},
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (
    !token ||
    token.length > 16384 ||
    !/^(?:meta\/bases(?:\/app[a-zA-Z0-9]{14}\/tables)?|app[a-zA-Z0-9]{14}\/tbl[a-zA-Z0-9]{14}(?:\/rec[a-zA-Z0-9]{14})?)$/.test(path.split("?")[0]!) ||
    path.includes("#")
  )
    throw new AirtableRequestError("Invalid Airtable request.", 400);
  let response: Response;
  try {
    response = await request("https://api.airtable.com/v0/" + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
    });
  } catch {
    throw new AirtableRequestError(
      "Airtable did not confirm the request. Check the table before trying again.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status))
      throw new AirtableRequestError(
        "Airtable refused access. Check base permissions or reconnect Airtable.",
        response.status,
      );
    if (response.status === 429)
      throw new AirtableRequestError(
        "Airtable is rate limiting requests. Wait before trying again.",
        429,
      );
    throw new AirtableRequestError(
      "Airtable did not confirm the request. Check the table and field values before trying again.",
      response.status,
    );
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1048576) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AirtableRequestError(
      "Airtable returned an invalid response. Check the table before trying again.",
    );
  }
}
export interface AirtableField {
  id: string;
  name: string;
  type: string;
}
export interface AirtableTable {
  id: string;
  name: string;
  fields: AirtableField[];
  views: Array<{ id: string; name: string }>;
}
export async function airtableTables(
  base_id: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<AirtableTable[]> {
  if (!airtableId(base_id, "app"))
    throw new AirtableRequestError("Choose a valid base_id.", 400);
  const raw = await airtableJson(
    "meta/bases/" + base_id + "/tables",
    token,
    {},
    request,
  );
  if (!object(raw) || !Array.isArray(raw.tables) || raw.tables.length > 1000)
    throw new AirtableRequestError("Airtable returned invalid tables.");
  return raw.tables.map((t) => {
    if (
      !object(t) ||
      !airtableId(t.id, "tbl") ||
      typeof t.name !== "string" ||
      !Array.isArray(t.fields) ||
      t.fields.length > 1000 ||
      !Array.isArray(t.views)
    )
      throw new AirtableRequestError("Airtable returned an invalid table.");
    const fields = t.fields.map((f) => {
      if (
        !object(f) ||
        !airtableId(f.id, "fld") ||
        typeof f.name !== "string" ||
        typeof f.type !== "string"
      )
        throw new AirtableRequestError("Airtable returned an invalid field.");
      return { id: f.id as string, name: f.name, type: f.type };
    });
    const views = t.views.map((v) => {
      if (!object(v) || !airtableId(v.id, "viw") || typeof v.name !== "string")
        throw new AirtableRequestError("Airtable returned an invalid view.");
      return { id: v.id as string, name: v.name };
    });
    return { id: t.id as string, name: t.name, fields, views };
  });
}
function record(raw: unknown) {
  if (
    !object(raw) ||
    !airtableId(raw.id, "rec") ||
    typeof raw.createdTime !== "string" ||
    !Number.isFinite(Date.parse(raw.createdTime)) ||
    !object(raw.fields)
  )
    throw new AirtableRequestError(
      "Airtable returned an invalid record. Check the table before trying again.",
    );
  return { id: raw.id, createdTime: raw.createdTime, fields: raw.fields };
}
export const AIRTABLE_WRITABLE_TYPES = [
  "singleLineText",
  "multilineText",
  "richText",
  "email",
  "url",
  "phoneNumber",
  "number",
  "currency",
  "percent",
  "duration",
  "rating",
  "checkbox",
  "date",
  "dateTime",
  "singleSelect",
  "multipleSelects",
];
export async function runManagedAirtableAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const issue = managedAirtableIssue(action, input);
  if (issue) throw new Error(issue);
  const token = (input.auth as { secret_text?: unknown })?.secret_text;
  if (typeof token !== "string" || !token)
    throw new Error("Reconnect Airtable.");
  const path = String(input.base_id) + "/" + String(input.table_id_or_name);
  if (action === "get_record") {
    const result = record(
      await airtableJson(path + "/" + input.record_id, token, {}, request),
    );
    if (result.id !== input.record_id)
      throw new Error("Airtable returned a different record.");
    return result;
  }
  const table = (
    await airtableTables(String(input.base_id), token, request)
  ).find((t) => t.id === input.table_id_or_name);
  if (!table)
    throw new Error(
      "The selected table is no longer accessible in this base_id. Choose it again.",
    );
  if (action === "search_records") {
    const field = table.fields.find(
      (f) => f.id === input.search_field || f.name === input.search_field,
    );
    if (!field || /[{}\\\r\n]/.test(field.name))
      throw new Error(
        "Choose a searchable field in this table. Field names containing braces or backslashes are not supported.",
      );
    if (input.view && !table.views.some((v) => v.id === input.view))
      throw new Error("Choose a view belonging to this table.");
    const quoted = JSON.stringify(input.search_value);
    const query = new URLSearchParams({
      filterByFormula:
        input.match_mode === "exact"
          ? `{${field.name}}&""=${quoted}`
          : `FIND(${quoted},{${field.name}})`,
      pageSize: "100",
    });
    if (input.view) query.set("view", String(input.view));
    if (input.max_records) query.set("maxRecords", String(input.max_records));
    const records: ReturnType<typeof record>[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const raw = await airtableJson(path + "?" + query, token, {}, request);
      if (
        !object(raw) ||
        !Array.isArray(raw.records) ||
        raw.records.length > 100
      )
        throw new AirtableRequestError(
          "Airtable returned invalid search results.",
        );
      records.push(...raw.records.map(record));
      if (
        raw.offset === undefined ||
        (input.max_records && records.length >= Number(input.max_records))
      ) {
        const selected = input.max_records
          ? records.slice(0, Number(input.max_records))
          : records;
        return { records: selected, count: selected.length };
      }
      if (
        typeof raw.offset !== "string" ||
        !raw.offset ||
        raw.offset.length > 1024 ||
        seen.has(raw.offset)
      )
        throw new AirtableRequestError("Airtable returned invalid pagination.");
      seen.add(raw.offset);
      query.set("offset", raw.offset);
    }
    throw new Error(
      "Search exceeds 1,000 records. Narrow the search or select a view.",
    );
  }
  const supplied = airtableFields(input.fields)!;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(supplied)) {
    const field = table.fields.find((f) => f.id === key || f.name === key);
    if (!field || !AIRTABLE_WRITABLE_TYPES.includes(field.type))
      throw new Error(
        "Use existing text, number, checkbox, date or select fields. Attachments, linked records and computed fields are not supported.",
      );
    if (Object.hasOwn(fields, field.id))
      throw new Error("A field was supplied twice. Use its ID or its name.");
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean" &&
      !(
        Array.isArray(value) &&
        value.length <= 100 &&
        value.every((v) => typeof v === "string")
      )
    )
      throw new Error(
        "Field values must be text, numbers, booleans, null or arrays of text.",
      );
    fields[field.id] = value;
  }
  const update = action === "update_record_ai";
  const result = record(
    await airtableJson(
      path + (update ? "/" + input.record_id : ""),
      token,
      {
        method: update ? "PATCH" : "POST",
        body: JSON.stringify({ fields, typecast: false }),
      },
      request,
    ),
  );
  if (update && result.id !== input.record_id)
    throw new Error(
      "Airtable did not confirm the record update. Check the table before trying again.",
    );
  return result;
}
