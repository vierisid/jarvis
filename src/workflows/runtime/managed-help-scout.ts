/** Reviewed Inbox API endpoints. Search never silently picks the first match; writes are attempted once. */
export const MANAGED_HELP_SCOUT_ACTIONS = [
  "find_customer",
  "find_conversation",
  "add_note",
] as const;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== null && v !== "";
export function managedHelpScoutInput(piece: string, input: unknown): boolean {
  return (
    piece === "@activepieces/piece-help-scout" &&
    record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "help-scout"
  );
}
function id(v: unknown): string {
  if (typeof v === "number" && Number.isSafeInteger(v)) v = String(v);
  if (
    typeof v !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(v) ||
    !Number.isSafeInteger(Number(v))
  )
    throw new Error(
      "Enter a positive numeric Help Scout ID or conversation number.",
    );
  return v;
}
function email(v: unknown): string {
  if (
    typeof v !== "string" ||
    v.length > 254 ||
    !/^[^\s@"\\():<>\x00-\x1f\x7f]+@[^\s@"\\():<>\x00-\x1f\x7f]+\.[^\s@"\\():<>\x00-\x1f\x7f]+$/.test(
      v,
    )
  )
    throw new Error("Enter a valid customer email address.");
  return v.toLowerCase();
}
function note(v: unknown): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > 10000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)
  )
    throw new Error("Enter an internal note of 1 to 10,000 characters.");
  // The API accepts HTML. Treat workflow content as plain text, including interpolated customer data.
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, "<br>");
}
const label = (v: unknown) => (typeof v === "string" ? v : "");
function conversation(raw: unknown, expected?: string) {
  if (
    !record(raw) ||
    (expected && id(raw.id) !== expected) ||
    typeof raw.subject !== "string" ||
    typeof raw.status !== "string"
  )
    throw new Error("Help Scout returned invalid conversation details.");
  return {
    id: Number(id(raw.id)),
    number: Number(id(raw.number)),
    mailboxId: Number(id(raw.mailboxId)),
    subject: raw.subject,
    status: raw.status,
    preview: label(raw.preview),
    primaryCustomer: {
      id:
        raw.primaryCustomer?.id == null
          ? null
          : Number(id(raw.primaryCustomer.id)),
      email: label(raw.primaryCustomer?.email),
    },
  };
}
async function api(
  token: string,
  path: string,
  request: typeof fetch,
  body?: Record<string, unknown>,
): Promise<any> {
  let response: Response;
  try {
    response = await request("https://api.helpscout.net/v2" + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // redirect: "error" also lands here: Help Scout answers a merged
    // conversation's old ID with a redirect, which only a lookup by ID meets.
    throw new Error(
      body
        ? "Help Scout did not confirm the note. Check the conversation before trying again."
        : /^\/conversations\/[0-9]+$/.test(path)
          ? "Help Scout could not be reached. Check the conversation ID if it was merged, or try again later."
          : "Help Scout could not be reached. Try again later.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? "Help Scout refused access. Reconnect Help Scout."
        : response.status === 429
          ? body
            ? "Help Scout is rate limiting requests. Check the conversation before trying again later."
            : "Help Scout is rate limiting requests. Try again later."
          : "Help Scout could not complete the request. Check the record, inbox access and account permissions before trying again.",
    );
  }
  if (body) {
    await response.body?.cancel().catch(() => {});
    const value = response.headers.get("resource-id");
    if (
      response.status !== 201 ||
      !value ||
      !/^[1-9][0-9]{0,15}$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new Error(
        "Help Scout did not confirm the note ID. Check the conversation before trying again.",
      );
    return { id: value };
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Help Scout returned an empty response.");
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
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(result)) throw new Error();
    return result;
  } catch {
    throw new Error("Help Scout returned an invalid or oversized response.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Search endpoints are paginated and may use substring matching. Scan a bounded complete result set,
 * then apply exact matching. Never follow server-provided links or claim no match for an incomplete scan. */
async function search(
  token: string,
  path: string,
  key: string,
  request: typeof fetch,
): Promise<Record<string, any>[]> {
  const rows: Record<string, any>[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const result = await api(token, path + "&page=" + page, request),
      batch = result._embedded?.[key],
      p = result.page;
    if (
      !Array.isArray(batch) ||
      !record(p) ||
      !Number.isSafeInteger(p.totalPages) ||
      p.totalPages < 0 ||
      !Number.isSafeInteger(p.totalElements) ||
      p.totalElements < 0 ||
      p.totalPages > 10 ||
      p.totalElements > 500
    )
      throw new Error(
        "Help Scout search is incomplete or too broad. Narrow the lookup.",
      );
    if (total !== undefined && total !== p.totalElements)
      throw new Error(
        "Help Scout search changed while reading. Try the lookup again.",
      );
    total = p.totalElements;
    for (const row of batch) {
      if (!record(row))
        throw new Error("Help Scout returned an invalid search result.");
      const key = id(row.id);
      if (seen.has(key))
        throw new Error(
          "Help Scout returned overlapping search pages. Try again.",
        );
      seen.add(key);
      rows.push(row);
    }
    if (rows.length > 500)
      throw new Error("Help Scout search is too broad. Narrow the lookup.");
    if (page >= p.totalPages) {
      if (result._links?.next || rows.length !== total)
        throw new Error("Help Scout search is incomplete. Try again.");
      return rows;
    }
    if (!batch.length)
      throw new Error("Help Scout search is incomplete. Try again.");
  }
  throw new Error("Help Scout search is too broad. Narrow the lookup.");
}
export async function runManagedHelpScoutAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_HELP_SCOUT_ACTIONS as readonly string[]).includes(action))
    throw new Error(
      "This Help Scout action is not enabled for the managed connection.",
    );
  if (
    !record(input.auth) ||
    typeof input.auth.access_token !== "string" ||
    !input.auth.access_token
  )
    throw new Error("Reconnect Help Scout.");
  const user = id(input.auth.jarvis_user),
    token = input.auth.access_token;
  const fields =
    action === "find_customer"
      ? ["email"]
      : action === "find_conversation"
        ? ["conversationId", "mailboxId", "number"]
        : ["conversationId", "text"];
  for (const [key, value] of Object.entries(input))
    if (key !== "auth" && !fields.includes(key) && present(value))
      throw new Error(
        "Remove unsupported Help Scout fields before running this action.",
      );
  if (action === "add_note") {
    const conversationId = id(input.conversationId),
      text = note(input.text);
    return api(token, "/conversations/" + conversationId + "/notes", request, {
      text,
      user: Number(user),
    });
  }
  if (action === "find_conversation") {
    if (present(input.conversationId)) {
      if (present(input.mailboxId) || present(input.number))
        throw new Error(
          "Use a conversation ID, or an inbox ID and conversation number, not both.",
        );
      const conversationId = id(input.conversationId);
      return {
        found: true,
        data: conversation(
          await api(token, "/conversations/" + conversationId, request),
          conversationId,
        ),
      };
    }
    const mailbox = id(input.mailboxId),
      number = id(input.number);
    const rows = await search(
      token,
      "/conversations?status=all&mailbox=" + mailbox + "&number=" + number,
      "conversations",
      request,
    );
    const matches = rows
      .map((r) => conversation(r))
      .filter(
        (r) => String(r.mailboxId) === mailbox && String(r.number) === number,
      );
    if (matches.length > 1)
      throw new Error(
        "More than one Help Scout conversation matched. Use its conversation ID.",
      );
    return { found: matches.length === 1, data: matches[0] ?? {} };
  }
  const target = email(input.email);
  const rows = await search(
    token,
    "/customers?query=" + encodeURIComponent('(email:"' + target + '")'),
    "customers",
    request,
  );
  const matches: Record<string, unknown>[] = [];
  for (const row of rows) {
    const emails = row._embedded?.emails;
    if (
      !Array.isArray(emails) ||
      emails.some((e) => !record(e) || typeof e.value !== "string")
    )
      throw new Error("Help Scout returned incomplete customer email details.");
    if (emails.some((e) => e.value.toLowerCase() === target))
      matches.push({
        id: Number(id(row.id)),
        firstName: label(row.firstName),
        lastName: label(row.lastName),
        email: target,
      });
  }
  if (matches.length > 1)
    throw new Error(
      "More than one Help Scout customer has this email. Resolve duplicate customers before continuing.",
    );
  return { found: matches.length === 1, data: matches[0] ?? {} };
}
