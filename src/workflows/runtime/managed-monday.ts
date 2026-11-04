/** Reviewed operations for the hosted grant. Manual API-token accounts keep upstream behavior. */
export const MANAGED_MONDAY_ACTIONS = [
  "monday_create_item",
  "monday_get_item_column_values",
  "monday_update_item_name",
  "monday_update_column_values_of_item",
  "monday_create_update",
] as const;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const provided = (v: unknown) => v !== undefined && v !== null && v !== "";
export function mondayId(v: unknown): string {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,29}$/.test(v))
    throw Error("Enter a monday.com ID as text, or a workflow variable.");
  return v;
}
function key(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(v) ||
    ["__proto__", "prototype", "constructor"].includes(v)
  )
    throw Error("Enter a valid column or group ID.");
  return v;
}
function text(v: unknown, max = 512): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)
  )
    throw Error("Enter valid monday.com text.");
  return v;
}
export function managedMondayInput(
  input: unknown,
): Record<string, unknown> | null {
  return record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "monday"
    ? input
    : null;
}
const itemFields = "id name board { id } column_values { id type text value }";
function item(value: unknown, board: string, expected?: string) {
  if (
    !record(value) ||
    mondayId(value.id) !== (expected ?? value.id) ||
    value.board?.id !== board ||
    typeof value.name !== "string" ||
    !Array.isArray(value.column_values) ||
    value.column_values.length > 500
  )
    throw Error("monday.com did not return the requested board item.");
  for (const c of value.column_values) {
    if (
      !record(c) ||
      typeof c.type !== "string" ||
      (c.text !== null && typeof c.text !== "string") ||
      (c.value !== null && typeof c.value !== "string")
    )
      throw Error("monday.com returned invalid column values.");
    key(c.id);
  }
  return value;
}
function columns(input: unknown): Record<string, unknown> {
  if (!provided(input)) return {};
  if (!record(input) || Object.keys(input).length > 50)
    throw Error("Supply at most 50 column values as a JSON object.");
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    key(k);
    if (["name", "id", "board_id"].includes(k))
      throw Error("Use the item name field to rename an item.");
    // Empty values preserve existing fields. Clearing data is deliberately not enabled.
    if (!provided(v)) continue;
    if (
      !["string", "number", "boolean"].includes(typeof v) ||
      (typeof v === "number" && !Number.isFinite(v)) ||
      (typeof v === "string" && v.length > 10000)
    )
      throw Error("Column values must be text, numbers or booleans.");
    result[k] = v;
  }
  return result;
}
export async function mondayBoard(
  token: string,
  board: string,
  request: typeof fetch = fetch,
) {
  const d = await mondayGraphql(
    token,
    "query JarvisBoard($ids: [ID!]) { boards(ids: $ids) { id name groups { id title } columns { id title type settings_str } } }",
    { ids: [mondayId(board)] },
    request,
  );
  if (
    !Array.isArray(d.boards) ||
    d.boards.length !== 1 ||
    d.boards[0]?.id !== board ||
    !Array.isArray(d.boards[0].groups) ||
    !Array.isArray(d.boards[0].columns)
  )
    throw Error("Cannot access this monday.com board.");
  return d.boards[0];
}
function encodeColumns(
  values: Record<string, unknown>,
  metadata: any[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(values)) {
    const c = metadata.find((c) => c.id === id);
    if (!c) throw Error("A selected column does not exist on this board.");
    switch (c.type) {
      case "text":
        if (typeof v !== "string") throw Error("Text columns need text.");
        result[id] = v;
        break;
      case "long_text":
        if (typeof v !== "string") throw Error("Long text columns need text.");
        result[id] = { text: v };
        break;
      case "numbers":
        if (typeof v !== "number")
          throw Error("Numbers columns need a number.");
        result[id] = String(v);
        break;
      case "checkbox":
        if (typeof v !== "boolean")
          throw Error("Checkbox columns need true or false.");
        result[id] = { checked: v ? "true" : "false" };
        break;
      case "date":
        if (
          typeof v !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
          !Number.isFinite(Date.parse(v)) ||
          new Date(v).toISOString().slice(0, 10) !== v
        )
          throw Error("Dates must use YYYY-MM-DD.");
        result[id] = { date: v };
        break;
      case "status": {
        let labels: Record<string, unknown>;
        try {
          labels = JSON.parse(c.settings_str).labels;
          if (!record(labels)) throw Error();
        } catch {
          throw Error("Cannot read the board's status labels.");
        }
        const matches = Object.entries(labels).filter(([index, label]) =>
          typeof v === "number" ? String(v) === index : v === label,
        );
        if (matches.length !== 1 || !/^\d+$/.test(matches[0]![0]))
          throw Error(
            "Choose an existing status label or index. New labels are not created.",
          );
        result[id] = { index: Number(matches[0]![0]) };
        break;
      }
      default:
        throw Error(
          "Only text, long text, numbers, checkbox, date and status columns can be changed.",
        );
    }
  }
  return result;
}
function verifyValues(actual: any, expected: Record<string, unknown>) {
  for (const [id, v] of Object.entries(expected)) {
    if (id === "name") {
      if (actual.name !== v)
        throw Error("monday.com did not confirm the item name.");
      continue;
    }
    const column = actual.column_values.find((c: any) => c.id === id);
    let raw: any;
    try {
      raw = JSON.parse(column?.value);
    } catch {
      throw Error(
        "monday.com did not confirm the changed fields. Check the item before retrying.",
      );
    }
    const matches =
      column?.type === "checkbox" && record(v)
        ? (raw === null || [true, false, "true", "false"].includes(raw?.checked)) &&
          (raw?.checked === true || raw?.checked === "true") === (v.checked === "true")
        : record(v)
          ? Object.entries(v).every(([k, val]) => raw?.[k] === val)
          : raw === v;
    if (!matches)
      throw Error(
        "monday.com did not confirm the changed fields. Check the item before retrying.",
      );
  }
}
export async function mondayGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  request: typeof fetch = fetch,
  writing = false,
): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await request("https://api.monday.com/v2", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: token,
        "API-Version": "2026-07",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error(
      writing
        ? "monday.com's result is uncertain. Check the item before trying again."
        : "monday.com could not be reached. Try again shortly.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? "monday.com refused access. Reconnect monday.com."
        : response.status === 429
          ? "monday.com is rate limiting requests. Try again later."
          : "monday.com refused this request. Check access and the item before retrying.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("monday.com returned an empty response.");
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) throw new Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    // A GraphQL 200 may contain partial data AND errors. Never treat that as success.
    if (
      !record(value) ||
      (value.errors !== undefined &&
        (!Array.isArray(value.errors) || value.errors.length)) ||
      !record(value.data)
    )
      throw new Error();
    return value.data;
  } catch {
    throw new Error(
      "monday.com returned errors or an invalid response. Check permissions and the item before retrying.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function runManagedMondayAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_MONDAY_ACTIONS as readonly string[]).includes(action))
    throw Error(
      "This monday.com action is not enabled for the hosted connection.",
    );
  if (
    !record(input.auth) ||
    typeof input.auth.secret_text !== "string" ||
    !input.auth.secret_text
  )
    throw Error("Reconnect monday.com.");
  const token = input.auth.secret_text;
  const gql = (
    query: string,
    variables: Record<string, unknown>,
    writing = false,
  ) => mondayGraphql(token, query, variables, request, writing);
  const board = mondayId(input.board_id);
  const creating = action === "monday_create_item",
    reading = action === "monday_get_item_column_values",
    commenting = action === "monday_create_update",
    renaming = action === "monday_update_item_name";
  const reference = creating ? undefined : mondayId(input.item_id);
  const name = creating
    ? text(input.item_name)
    : renaming
      ? text(input.name)
      : undefined;
  const body = commenting ? text(input.body, 100000) : undefined;
  if (
    provided(input.create_labels_if_missing) &&
    input.create_labels_if_missing !== false
  )
    throw Error("Creating board labels is not enabled.");
  const group =
    creating && provided(input.group_id) ? key(input.group_id) : undefined;
  const values =
    creating || action === "monday_update_column_values_of_item"
      ? columns(input.column_values)
      : {};
  if (
    action === "monday_update_column_values_of_item" &&
    !Object.keys(values).length
  )
    throw Error("Choose at least one column to update.");
  let columnIds: string[] | undefined;
  if (provided(input.column_ids)) {
    if (!Array.isArray(input.column_ids) || input.column_ids.length > 100)
      throw Error("Use an array of at most 100 column IDs.");
    columnIds = input.column_ids.map(key);
  }
  let target: any;
  if (reference) {
    const result = await gql(
      `query JarvisItem($ids: [ID!]) { items(ids: $ids) { ${itemFields} } }`,
      { ids: [reference] },
    );
    if (!Array.isArray(result.items) || result.items.length !== 1)
      throw Error("Cannot access this monday.com item.");
    target = item(result.items[0], board, reference);
  }
  if (reading) {
    const out: Record<string, unknown> = { id: target.id, name: target.name };
    for (const c of target.column_values) {
      if (
        (columnIds?.length && !columnIds.includes(c.id)) ||
        ["id", "name"].includes(c.id)
      )
        continue;
      // Preserve the upstream flat column-ID shape. Text is stable for all column types.
      Object.defineProperty(out, c.id, { value: c.text, enumerable: true });
    }
    return out;
  }
  if (commenting) {
    // Plain text only: prevent hidden HTML mentions, links or embeds from changing meaning.
    const html = body!
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
      .replaceAll("\n", "<br>");
    const data = await gql(
      "mutation JarvisCreateUpdate($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }",
      { item: reference, body: html },
      true,
    );
    return {
      data: { create_update: { id: mondayId(data.create_update?.id) } },
    };
  }
  const meta = await mondayBoard(token, board, request);
  if (group && !meta.groups.some((g: any) => g.id === group))
    throw Error("The selected group does not belong to this board.");
  const encoded = renaming ? { name } : encodeColumns(values, meta.columns);
  const data = creating
    ? await gql(
        `mutation JarvisCreateItem($board: ID!, $group: String, $name: String!, $values: JSON) { create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values, create_labels_if_missing: false) { ${itemFields} } }`,
        { board, group: group ?? null, name, values: JSON.stringify(encoded) },
        true,
      )
    : await gql(
        `mutation JarvisChangeColumns($board: ID!, $item: ID!, $values: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values, create_labels_if_missing: false) { ${itemFields} } }`,
        { board, item: reference, values: JSON.stringify(encoded) },
        true,
      );
  const result = item(
    data[creating ? "create_item" : "change_multiple_column_values"],
    board,
    reference,
  );
  verifyValues(result, encoded);
  if (creating && result.name !== name)
    throw Error(
      "monday.com did not confirm the created item name. Check the board before retrying.",
    );
  return creating
    ? { data: { create_item: { id: result.id } } }
    : {
        data: {
          change_multiple_column_values: { id: result.id, name: result.name },
        },
      };
}
