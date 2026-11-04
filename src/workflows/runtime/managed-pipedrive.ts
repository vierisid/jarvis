import { pipedriveInputSchema } from "./managed-pipedrive-inputs";
export const MANAGED_PIPEDRIVE_ACTIONS = [
  "get-person",
  "search-persons",
  "create-person",
  "update-person",
  "get-deal",
  "search-deals",
  "create-deal",
  "update-deal",
] as const;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== null && v !== "";
export function pipedriveId(v: unknown): number {
  const n = typeof v === "string" && /^[1-9][0-9]*$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1)
    throw Error("Enter a positive numeric Pipedrive ID or workflow variable.");
  return n;
}
export function pipedriveHost(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pipedrive\.com$/.test(v)
  )
    throw Error("Reconnect Pipedrive.");
  return v;
}
function text(v: unknown, label: string, max = 1000): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\x00-\x1f\x7f]/.test(v)
  )
    throw Error("Enter a valid Pipedrive " + label + ".");
  return v;
}
export function managedPipedriveInput(
  piece: string,
  input: unknown,
): input is Record<string, unknown> {
  return (
    piece === "@activepieces/piece-pipedrive" &&
    record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "pipedrive"
  );
}
/** Bounded responses and one attempt per write. Only fixed paths below call this helper. */
async function requestApi(
  auth: Record<string, any>,
  path: string,
  method: string,
  body: unknown,
  request: typeof fetch,
) {
  const host = pipedriveHost(auth.api_host);
  if (
    typeof auth.access_token !== "string" ||
    !auth.access_token ||
    auth.access_token.length > 16384
  )
    throw Error("Reconnect Pipedrive.");
  const uncertain =
    method === "GET"
      ? " Try again shortly."
      : " Check Pipedrive before trying again; the record may already have changed.";
  let response: Response;
  try {
    response = await request("https://" + host + "/api/v2" + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + auth.access_token,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw Error("Pipedrive did not confirm the request." + uncertain);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401)
      throw Error("Pipedrive refused access. Reconnect Pipedrive.");
    if (response.status === 404 && method === "GET")
      throw Error(
        "Pipedrive could not find that record. It does not exist or was deleted.",
      );
    if (response.status === 429)
      throw Error(
        "Pipedrive is rate limiting requests. Wait before trying again.",
      );
    throw Error(
      "Pipedrive refused the request (HTTP " +
        response.status +
        ")." +
        uncertain,
    );
  }
  const reader = response.body?.getReader();
  try {
    if (!reader) throw Error();
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
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !record(result) ||
      result.success !== true ||
      result.error ||
      result.errors
    )
      throw Error();
    return result;
  } catch {
    throw Error(
      "Pipedrive returned an invalid or oversized response." + uncertain,
    );
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
function entity(
  v: unknown,
  person: boolean,
  expected?: number,
): Record<string, any> {
  if (
    !record(v) ||
    typeof v.id !== "number" ||
    !Number.isSafeInteger(v.id) ||
    v.id < 1 ||
    (expected && v.id !== expected) ||
    typeof v[person ? "name" : "title"] !== "string"
  )
    throw Error(
      "Pipedrive returned an invalid record. Check the target before retrying.",
    );
  return v;
}
export async function runManagedPipedriveAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const schema = pipedriveInputSchema(action);
  if (!schema)
    throw Error(
      "This Pipedrive action is not enabled for the managed connection.",
    );
  if (!record(input.auth)) throw Error("Reconnect Pipedrive.");
  const allowed = new Set(["auth", ...schema.fields.map((f) => f.name)]);
  for (const [key, value] of Object.entries(input))
    if (
      !allowed.has(key) &&
      present(value) &&
      !(Array.isArray(value) && !value.length) &&
      !(record(value) && !Object.keys(value).length)
    )
      throw Error(
        "This managed Pipedrive action does not support " +
          key +
          ". Remove it before running.",
      );
  const person = action.endsWith("person") || action === "search-persons";
  const resource = person ? "/persons" : "/deals";
  const key = person ? "personId" : "dealId";
  if (action.startsWith("get-")) {
    const id = pipedriveId(input[key]);
    const response = await requestApi(
      input.auth,
      resource + "/" + id,
      "GET",
      undefined,
      request,
    );
    return { success: true, data: entity(response.data, person, id) };
  }
  if (action.startsWith("search-")) {
    const term = text(input.term, "search term", 256);
    if (present(input.exactMatch) && typeof input.exactMatch !== "boolean")
      throw Error("Choose whether to use an exact match.");
    if (term.length < (input.exactMatch === true ? 1 : 2))
      throw Error("Enter at least two characters, or enable exact match.");
    const validFields = person ? ["name", "email", "phone"] : ["title"];
    const fields = input.fields ?? [];
    if (
      !Array.isArray(fields) ||
      fields.length > validFields.length ||
      fields.some((f) => !validFields.includes(f))
    )
      throw Error("Choose supported Pipedrive search fields.");
    const limit = input.limit ?? 50;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw Error("Choose 1-100 results per page.");
    const params = new URLSearchParams({
      term,
      fields: (fields.length ? fields : validFields).join(","),
      limit: String(limit),
    });
    if (present(input.exactMatch))
      params.set("exact_match", String(input.exactMatch));
    if (present(input.cursor))
      params.set("cursor", text(input.cursor, "cursor", 4096));
    for (const [field, api] of [
      ["personId", "person_id"],
      ["organizationId", "organization_id"],
    ])
      if (present(input[field!]))
        params.set(api!, String(pipedriveId(input[field!])));
    if (present(input.status)) {
      if (!["open", "won", "lost"].includes(String(input.status)))
        throw Error("Choose a valid deal status.");
      params.set("status", String(input.status));
    }
    const response = await requestApi(
      input.auth,
      resource + "/search?" + params,
      "GET",
      undefined,
      request,
    );
    if (
      !record(response.data) ||
      !Array.isArray(response.data.items) ||
      response.data.items.length > limit
    )
      throw Error("Pipedrive returned invalid search results.");
    const data = response.data.items.map((row: any) => {
      if (!record(row))
        throw Error("Pipedrive returned invalid search results.");
      const item = entity(row.item, person);
      if (
        row.result_score !== undefined &&
        (typeof row.result_score !== "number" ||
          !Number.isFinite(row.result_score))
      )
        throw Error("Pipedrive returned an invalid search score.");
      return {
        ...item,
        ...(row.result_score === undefined
          ? {}
          : { result_score: row.result_score }),
      };
    });
    const cursor = response.additional_data?.next_cursor ?? null;
    if (cursor !== null) text(cursor, "cursor", 4096);
    return { found: data.length > 0, data, next_cursor: cursor };
  }
  const create = action.startsWith("create-");
  const body: Record<string, unknown> = {};
  const name = person ? "name" : "title";
  if (create || present(input[name])) body[name] = text(input[name], name, 255);
  for (const [field, api] of [
    ["organizationId", "org_id"],
    ...(!person
      ? [
          ["personId", "person_id"],
          ["pipelineId", "pipeline_id"],
          ["stageId", "stage_id"],
        ]
      : []),
  ])
    if (present(input[field!])) body[api!] = pipedriveId(input[field!]);
  if (person) {
    for (const [field, api] of [
      ["email", "emails"],
      ["phone", "phones"],
    ]) {
      const values = input[field!];
      if (!present(values)) continue;
      if (!Array.isArray(values) || values.length > 20)
        throw Error(
          "Enter Pipedrive " + field + " values as a JSON array (up to 20).",
        );
      if (values.length)
        body[api!] = values.map((v, i) => {
          const value = text(v, field!, field === "email" ? 254 : 100);
          if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
            throw Error("Enter a valid email address.");
          return { value, label: "work", primary: i === 0 };
        });
    }
  } else {
    for (const [field, api, max] of [
      ["dealValue", "value", 1e15],
      ["probability", "probability", 100],
    ] as const)
      if (present(input[field])) {
        const value = input[field];
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > max
        )
          throw Error("Enter a valid deal " + api + ".");
        body[api] = value;
      }
    if (present(input.dealValueCurrency)) {
      if (
        typeof input.dealValueCurrency !== "string" ||
        !/^[A-Z]{3}$/.test(input.dealValueCurrency)
      )
        throw Error("Use a three-letter uppercase currency code.");
      body.currency = input.dealValueCurrency;
    }
    if (present(input.status)) {
      if (!["open", "won", "lost"].includes(String(input.status)))
        throw Error("Choose open, won or lost.");
      body.status = input.status;
    }
    if (present(input.expectedCloseDate)) {
      const v = input.expectedCloseDate;
      if (
        typeof v !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
        !Number.isFinite(Date.parse(v)) ||
        new Date(v).toISOString().slice(0, 10) !== v
      )
        throw Error("Use a valid YYYY-MM-DD close date.");
      body.expected_close_date = v;
    }
  }
  if (!Object.keys(body).length)
    throw Error(
      "Choose at least one field to update. Empty fields preserve existing values.",
    );
  const id = create ? undefined : pipedriveId(input[key]);
  const response = await requestApi(
    input.auth,
    resource + (id ? "/" + id : ""),
    create ? "POST" : "PATCH",
    body,
    request,
  );
  return { success: true, data: entity(response.data, person, id) };
}
