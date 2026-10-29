/** The published 0.3.0 piece uses retired v1 routes. Managed grants use fixed v2 CMS routes. */
export const MANAGED_WEBFLOW_ACTIONS = [
  "create_collection_item",
  "update_collection_item",
  "get_collection_item",
  "find_collection_item",
] as const;
export const WEBFLOW_ID = /^[a-f0-9]{24}$/;
export const WEBFLOW_TEXT_TYPES = [
  "PlainText",
  "RichText",
  "Email",
  "Link",
  "Phone",
  "Color",
];
export const WEBFLOW_FIELD_TYPES = [
  ...WEBFLOW_TEXT_TYPES,
  "Number",
  "Switch",
  "DateTime",
  "Option",
];
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function webflowId(v: unknown): string {
  if (typeof v !== "string" || !WEBFLOW_ID.test(v))
    throw Error("Enter a valid Webflow ID.");
  return v;
}
export function managedWebflowInput(
  piece: string,
  input: unknown,
): input is Record<string, unknown> {
  return (
    piece === "@activepieces/piece-webflow" &&
    record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "webflow"
  );
}
export const WEBFLOW_RESPONSE_LIMIT = 2 * 1024 * 1024;
/** Only fixed paths constructed below may call this helper. Never follow provider or user URLs. */
export async function webflowRequest(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
  request: typeof fetch = fetch,
): Promise<Record<string, any>> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
    throw Error("Invalid Webflow path.");
  const uncertain =
    method === "GET"
      ? " Try again shortly."
      : " Check the collection before trying again; the draft may already have changed.";
  let response: Response;
  try {
    response = await request("https://api.webflow.com/v2" + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw Error("Webflow did not confirm the request." + uncertain);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status))
      throw Error(
        "Webflow refused access. Check the site permissions or reconnect Webflow.",
      );
    if (response.status === 429)
      throw Error(
        "Webflow is rate limiting requests. Wait before trying again." +
          uncertain,
      );
    throw Error(
      "Webflow could not complete the request (HTTP " +
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
      if (size > WEBFLOW_RESPONSE_LIMIT) throw Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(result) || result.error || result.errors) throw Error();
    return result;
  } catch {
    throw Error(
      "Webflow returned an invalid or oversized response (2 MiB limit)." +
        uncertain,
    );
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
export interface WebflowField {
  slug: string;
  displayName: string;
  type: string;
  isRequired: boolean;
  isEditable: boolean;
  options: Array<{ id: string; name: string }>;
}
export function webflowFields(
  schema: Record<string, any>,
  collection: string,
): WebflowField[] {
  if (
    schema.id !== collection ||
    !Array.isArray(schema.fields) ||
    schema.fields.length > 100
  )
    throw Error("Webflow returned an invalid collection schema.");
  const seen = new Set<string>();
  return schema.fields.map((field: any) => {
    if (
      !record(field) ||
      typeof field.slug !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,255}$/.test(field.slug) ||
      seen.has(field.slug) ||
      typeof field.displayName !== "string" ||
      typeof field.type !== "string" ||
      typeof field.isRequired !== "boolean" ||
      typeof field.isEditable !== "boolean"
    )
      throw Error("Webflow returned an invalid collection field.");
    seen.add(field.slug);
    const options = field.type === "Option" ? field.validations?.options : [];
    if (
      !Array.isArray(options) ||
      options.length > 100 ||
      options.some(
        (o: any) =>
          !record(o) ||
          typeof o.id !== "string" ||
          !o.id ||
          typeof o.name !== "string",
      )
    )
      throw Error("Webflow returned invalid field options.");
    return {
      slug: field.slug,
      displayName: field.displayName.slice(0, 200),
      type: field.type,
      isRequired: field.isRequired,
      isEditable: field.isEditable,
      options: options.map((o: any) => ({ id: o.id, name: o.name })),
    };
  });
}
export async function webflowCollections(
  token: string,
  site: string,
  request: typeof fetch = fetch,
) {
  const body = await webflowRequest(
    token,
    "/sites/" + webflowId(site) + "/collections",
    "GET",
    undefined,
    request,
  );
  if (!Array.isArray(body.collections) || body.collections.length > 100)
    throw Error("Webflow returned invalid collections.");
  const seen = new Set<string>();
  return body.collections.map((c: any) => {
    const id = webflowId(c?.id);
    if (seen.has(id) || typeof c.displayName !== "string")
      throw Error("Webflow returned invalid collections.");
    seen.add(id);
    return { id, name: c.displayName.slice(0, 200) };
  });
}
export async function webflowCollectionContext(
  token: string,
  site: string,
  collection: string,
  request: typeof fetch = fetch,
) {
  // A collection endpoint alone does not establish that it belongs to the selected site.
  const choices = await webflowCollections(token, site, request);
  if (!choices.some((c) => c.id === collection))
    throw Error("Choose a collection in the selected Webflow site.");
  const siteData = await webflowRequest(
    token,
    "/sites/" + site,
    "GET",
    undefined,
    request,
  );
  if (siteData.id !== site) throw Error("Webflow returned a different site.");
  const locale = siteData.locales?.primary?.cmsLocaleId;
  if (siteData.locales != null && !locale)
    throw Error("Webflow did not identify the primary language.");
  return {
    locale: locale ? webflowId(locale) : null,
    fields: webflowFields(
      await webflowRequest(
        token,
        "/collections/" + collection,
        "GET",
        undefined,
        request,
      ),
      collection,
    ),
  };
}
function item(
  raw: unknown,
  locale: string | null,
  expectedId?: string,
): Record<string, any> {
  if (
    !record(raw) ||
    typeof raw.id !== "string" ||
    !WEBFLOW_ID.test(raw.id) ||
    (expectedId && raw.id !== expectedId) ||
    !record(raw.fieldData) ||
    typeof raw.fieldData.name !== "string" ||
    typeof raw.fieldData.slug !== "string" ||
    typeof raw.isDraft !== "boolean" ||
    typeof raw.isArchived !== "boolean" ||
    (locale && raw.cmsLocaleId !== locale)
  )
    throw Error(
      "Webflow returned an invalid CMS item. Check the collection before trying again.",
    );
  return {
    id: raw.id,
    fieldData: raw.fieldData,
    isDraft: raw.isDraft,
    isArchived: raw.isArchived,
    ...(raw.cmsLocaleId ? { cmsLocaleId: raw.cmsLocaleId } : {}),
    ...Object.fromEntries(
      ["lastPublished", "lastUpdated", "createdOn"]
        .filter((k) => raw[k] === null || typeof raw[k] === "string")
        .map((k) => [k, raw[k]]),
    ),
  };
}
function fieldValue(field: WebflowField, value: unknown): unknown {
  if (!WEBFLOW_FIELD_TYPES.includes(field.type))
    throw Error(
      "This Webflow field type is not supported yet: " + field.type + ".",
    );
  if (WEBFLOW_TEXT_TYPES.includes(field.type)) {
    if (
      typeof value !== "string" ||
      value.length > 65536 ||
      (field.isRequired && !value.trim())
    )
      throw Error("Enter text for " + field.displayName + ".");
    return value;
  }
  if (
    field.type === "Number" &&
    typeof value === "number" &&
    Number.isFinite(value)
  )
    return value;
  if (field.type === "Switch" && typeof value === "boolean") return value;
  if (
    field.type === "DateTime" &&
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
    return value;
  if (
    field.type === "Option" &&
    typeof value === "string" &&
    field.options.some((o) => o.id === value)
  )
    return value;
  throw Error("Enter a valid value for " + field.displayName + ".");
}
export async function runManagedWebflowAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_WEBFLOW_ACTIONS as readonly string[]).includes(action))
    throw Error(
      "This Webflow action is not enabled for the managed connection.",
    );
  const auth = record(input.auth) ? input.auth : {};
  if (
    typeof auth.access_token !== "string" ||
    !auth.access_token ||
    auth.access_token.length > 16384
  )
    throw Error("Reconnect Webflow.");
  const site = webflowId(input.site_id),
    collection = webflowId(input.collection_id);
  if (
    !Array.isArray(auth.webflow_site_ids) ||
    !auth.webflow_site_ids.includes(site)
  )
    throw Error(
      "Choose a connected Webflow site. Reconnect to add another site.",
    );
  const writing =
    action === "create_collection_item" || action === "update_collection_item";
  if (
    writing &&
    ((input.is_draft !== undefined && input.is_draft !== true) ||
      (input.is_archived !== undefined && input.is_archived !== false))
  )
    throw Error(
      "Managed Webflow writes must stay in draft and cannot archive items.",
    );
  const target =
    action === "get_collection_item" || action === "update_collection_item"
      ? webflowId(input.collection_item_id)
      : null;
  const limit = input.max_results ?? 20;
  if (
    action === "find_collection_item" &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      typeof input.field_name !== "string" ||
      typeof input.field_value !== "string")
  )
    throw Error(
      "Choose a field, an exact value and a result limit from 1 to 100.",
    );
  const { locale, fields } = await webflowCollectionContext(
    auth.access_token,
    site,
    collection,
    request,
  );
  const query = new URLSearchParams(locale ? { cmsLocaleId: locale } : {});
  const root = "/collections/" + collection + "/items";
  if (action === "get_collection_item")
    return item(
      await webflowRequest(
        auth.access_token,
        root + "/" + target + "?" + query,
        "GET",
        undefined,
        request,
      ),
      locale,
      target!,
    );
  if (action === "find_collection_item") {
    const field = fields.find((f) => f.slug === input.field_name);
    if (!field || !WEBFLOW_TEXT_TYPES.includes(field.type))
      throw Error(
        "Find currently supports exact matches on text fields. Choose a text field slug.",
      );
    const matches: Record<string, any>[] = [],
      seen = new Set<string>();
    for (let offset = 0, pages = 0; offset < 1000 && pages < 10; pages++) {
      query.set("limit", "100");
      query.set("offset", String(offset));
      const page = await webflowRequest(
        auth.access_token,
        root + "?" + query,
        "GET",
        undefined,
        request,
      );
      if (
        !Array.isArray(page.items) ||
        page.items.length > 100 ||
        !record(page.pagination) ||
        page.pagination.offset !== offset ||
        !Number.isSafeInteger(page.pagination.total) ||
        page.pagination.total < offset + page.items.length
      )
        throw Error("Webflow returned invalid item pagination.");
      for (const raw of page.items) {
        const value = item(raw, locale);
        if (seen.has(value.id))
          throw Error("Webflow returned repeated items. Try the search again.");
        seen.add(value.id);
        if (value.fieldData[field.slug] === input.field_value)
          matches.push(value);
      }
      if (matches.length >= (limit as number))
        return { success: true, result: matches.slice(0, limit as number) };
      offset += page.items.length;
      if (offset === page.pagination.total)
        return { success: true, result: matches };
      if (!page.items.length)
        throw Error("Webflow returned an incomplete item page.");
    }
    throw Error(
      "This search exceeds the limit of 10 pages or 1,000 CMS items. Use a smaller collection or get an item by ID.",
    );
  }
  if (
    !record(input.collection_fields) ||
    !Object.keys(input.collection_fields).length
  )
    throw Error("Enter at least one collection field.");
  const fieldData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.collection_fields)) {
    const field = fields.find((f) => f.slug === key && f.isEditable);
    if (!field)
      throw Error("Choose an editable field in this Webflow collection.");
    fieldData[key] = fieldValue(field, value);
  }
  if (!target) {
    for (const field of fields.filter((f) => f.isRequired))
      if (!(field.slug in fieldData))
        throw Error("Complete the required field: " + field.displayName + ".");
    for (const key of ["name", "slug"])
      if (
        typeof fieldData[key] !== "string" ||
        !(fieldData[key] as string).trim()
      )
        throw Error("Enter the item name and slug.");
  } else {
    const current = item(
      await webflowRequest(
        auth.access_token,
        root + "/" + target + "?" + query,
        "GET",
        undefined,
        request,
      ),
      locale,
      target,
    );
    if (!current.isDraft || current.isArchived)
      throw Error(
        "Only existing, unarchived drafts can be updated. Save the item as a draft in Webflow first.",
      );
  }
  if (new TextEncoder().encode(JSON.stringify(fieldData)).byteLength > 262144)
    throw Error("Keep Webflow collection fields below 256 KiB per item.");
  const body = {
    fieldData,
    isDraft: true,
    isArchived: false,
    ...(locale ? { cmsLocaleId: locale } : {}),
  };
  // Single-item v2 endpoints retain the published action's single-item result contract.
  const result = item(
    await webflowRequest(
      auth.access_token,
      root + (target ? "/" + target : "") + "?skipInvalidFiles=false",
      target ? "PATCH" : "POST",
      body,
      request,
    ),
    locale,
    target ?? undefined,
  );
  if (!result.isDraft || result.isArchived)
    throw Error(
      "Webflow did not confirm the draft state. Check the collection before trying again.",
    );
  return result;
}
