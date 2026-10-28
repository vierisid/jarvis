/** Fetch-only managed adapter. Manual OAuth/internal-token accounts retain upstream behavior. */
export const MANAGED_NOTION_ACTIONS = [
  "find_page",
  "createPage",
  "append_to_page",
  "notion_get_block_children",
] as const;
export const notionId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(
    v,
  );
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function managedNotionInput(
  input: unknown,
): Record<string, unknown> | null {
  return (input as { auth?: { jarvis_managed?: unknown } } | null)?.auth
    ?.jarvis_managed === "notion"
    ? (input as Record<string, unknown>)
    : null;
}
export function managedNotionIssue(
  action: unknown,
  input: Record<string, unknown>,
  resolved = true,
): string | null {
  if (!(MANAGED_NOTION_ACTIONS as readonly unknown[]).includes(action))
    return "This Notion connection supports Find Page, Create Page, Append to Page and Get Page or Block Content. Other actions and triggers are not enabled.";
  const dynamic = (v: unknown) =>
    !resolved && typeof v === "string" && v.includes("{{");
  const idKey =
    action === "notion_get_block_children"
      ? "block_id"
      : action === "find_page"
        ? null
        : "pageId";
  if (idKey && !dynamic(input[idKey]) && !notionId(input[idKey]))
    return "Choose a shared Notion page or enter its ID or a workflow variable.";
  for (const [key, max, required] of [
    ["title", 2000, action === "find_page"],
    ["content", 20000, action === "append_to_page"],
  ] as const) {
    const v = input[key];
    if (dynamic(v)) continue;
    if (
      (required && (typeof v !== "string" || !v.trim())) ||
      (v != null && (typeof v !== "string" || v.length > max))
    )
      return `Enter ${key}${required ? " (required)" : ""}, up to ${max.toLocaleString("en-US")} characters.`;
  }
  if (action === "find_page") {
    if (
      input.limit != null &&
      !dynamic(input.limit) &&
      (!Number.isInteger(input.limit) ||
        Number(input.limit) < 1 ||
        Number(input.limit) > 100)
    )
      return "Limit must be between 1 and 100.";
    if (
      input.exact_match != null &&
      !dynamic(input.exact_match) &&
      typeof input.exact_match !== "boolean"
    )
      return "Exact Match must be true or false.";
  }
  if (action === "notion_get_block_children") {
    if (
      input.markdown != null &&
      !dynamic(input.markdown) &&
      input.markdown !== false
    )
      return "Managed Notion reads return block JSON. Turn Markdown off.";
    if (
      input.depth != null &&
      !dynamic(input.depth) &&
      (!Number.isInteger(input.depth) ||
        Number(input.depth) < 1 ||
        Number(input.depth) > 3)
    )
      return "Depth must be between 1 and 3.";
  }
  return null;
}
export class NotionRequestError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
export async function notionJson(
  path: string,
  token: string,
  init: RequestInit = {},
  request: typeof fetch = fetch,
): Promise<Record<string, any>> {
  const bare = path.split("?")[0]!;
  if (
    !token ||
    token.length > 16384 ||
    path.includes("#") ||
    !/^(?:users\/me|search|pages|blocks\/[a-f0-9-]+\/children)$/i.test(bare) ||
    (bare.startsWith("blocks/") && !notionId(bare.split("/")[1]))
  )
    throw new NotionRequestError("Invalid Notion request.", 400);
  let response: Response;
  try {
    response = await request("https://api.notion.com/v1/" + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        "Notion-Version": "2026-03-11",
        Authorization: "Bearer " + token,
      },
    });
  } catch {
    throw new NotionRequestError(
      "Notion did not confirm the request. Check the page before trying again.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const message =
      response.status === 429
        ? "Notion is rate limiting requests. Wait before trying again."
        : [401, 403, 404].includes(response.status)
          ? "Notion refused access. Share the page with Jarvis or reconnect Notion."
          : "Notion did not confirm the request. Check the page before trying again.";
    throw new NotionRequestError(message, response.status);
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
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    if (!object(raw)) throw new Error();
    return raw;
  } catch {
    throw new NotionRequestError(
      "Notion returned an invalid response. Check the page before trying again.",
    );
  }
}
export function notionPageTitle(page: Record<string, any>): string {
  const prop = Object.values(page.properties ?? {}).find(
    (p: any) => p?.type === "title",
  ) as any;
  return Array.isArray(prop?.title)
    ? prop.title.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")
    : "";
}
function page(raw: Record<string, any>) {
  if (
    raw.object !== "page" ||
    !notionId(raw.id) ||
    !object(raw.properties) ||
    typeof raw.url !== "string"
  )
    throw new NotionRequestError(
      "Notion returned an invalid page. Check the workspace before trying again.",
    );
  return raw;
}
function list(raw: Record<string, any>): Record<string, any>[] {
  if (
    raw.object !== "list" ||
    !Array.isArray(raw.results) ||
    raw.results.length > 100 ||
    !raw.results.every(object) ||
    typeof raw.has_more !== "boolean" ||
    (raw.has_more &&
      (typeof raw.next_cursor !== "string" ||
        !raw.next_cursor ||
        raw.next_cursor.length > 1024))
  )
    throw new NotionRequestError("Notion returned invalid pagination.");
  return raw.results;
}
function paragraphs(content: string) {
  const chunks = [];
  for (let i = 0; i < content.length; i += 2000)
    chunks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { type: "text", text: { content: content.slice(i, i + 2000) } },
        ],
      },
    });
  return chunks;
}
export async function runManagedNotionAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const issue = managedNotionIssue(action, input);
  if (issue) throw new Error(issue);
  const token = (input.auth as { access_token?: unknown })?.access_token;
  if (typeof token !== "string" || !token) throw new Error("Reconnect Notion.");
  if (action === "find_page") {
    const title = String(input.title),
      limit = Number(input.limit ?? 10),
      exact = input.exact_match === true;
    const matches: Record<string, any>[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined,
      hasMore = false;
    for (let n = 0; n < 10; n++) {
      const raw = await notionJson(
        "search",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            query: title,
            filter: { property: "object", value: "page" },
            sort: { direction: "descending", timestamp: "last_edited_time" },
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        },
        request,
      );
      const results = list(raw)
        .map(page)
        .filter((p) =>
          exact
            ? notionPageTitle(p).toLowerCase() === title.toLowerCase()
            : notionPageTitle(p).toLowerCase().includes(title.toLowerCase()),
        );
      matches.push(...results);
      hasMore = raw.has_more || matches.length > limit;
      if (matches.length >= limit || !raw.has_more) break;
      if (seen.has(raw.next_cursor))
        throw new NotionRequestError("Notion returned repeated pagination.");
      seen.add(raw.next_cursor);
      cursor = raw.next_cursor;
      if (n === 9)
        throw new Error(
          "Search exceeds 1,000 candidate pages. Narrow the title.",
        );
    }
    const pages = matches
      .slice(0, limit)
      .map((p) => ({
        id: p.id,
        title: notionPageTitle(p),
        url: p.url,
        created_time: p.created_time,
        last_edited_time: p.last_edited_time,
        archived: p.archived,
        parent: p.parent,
        properties: p.properties,
      }));
    return {
      success: true,
      searchTerm: title,
      exactMatch: exact,
      totalFound: matches.length,
      returned: pages.length,
      pages,
      summary: {
        searchTerm: title,
        matchType: exact ? "exact match" : "partial match",
        totalFound: matches.length,
        returned: pages.length,
        hasMore,
      },
      message: `Returned ${pages.length} matching pages${hasMore ? "; more may be available" : ""}.`,
    };
  }
  if (action === "notion_get_block_children") {
    let count = 0,
      calls = 0,
      bytes = 0;
    const visited = new Set<string>();
    const read = async (
      id: string,
      depth: number,
    ): Promise<Record<string, any>[]> => {
      if (visited.has(id))
        throw new Error("Notion returned cyclic block content.");
      visited.add(id);
      const blocks: Record<string, any>[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (;;) {
        if (++calls > 20)
          throw new Error(
            "Page content is too large. Read a specific child block.",
          );
        const q = new URLSearchParams({
          page_size: "100",
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        const raw = await notionJson(
          "blocks/" + id + "/children?" + q,
          token,
          {},
          request,
        );
        bytes += JSON.stringify(raw).length;
        if (bytes > 1048576)
          throw new Error(
            "Page content is too large. Read a specific child block.",
          );
        for (const block of list(raw)) {
          if (
            block.object !== "block" ||
            !notionId(block.id) ||
            typeof block.type !== "string" ||
            typeof block.has_children !== "boolean"
          )
            throw new NotionRequestError("Notion returned an invalid block.");
          if (++count > 1000)
            throw new Error(
              "Page exceeds 1,000 blocks. Read a specific child block.",
            );
          if (block.has_children)
            block.children = depth > 1 ? await read(block.id, depth - 1) : [];
          blocks.push(block);
        }
        if (!raw.has_more) break;
        if (cursors.has(raw.next_cursor))
          throw new NotionRequestError("Notion returned repeated pagination.");
        cursors.add(raw.next_cursor);
        cursor = raw.next_cursor;
      }
      return blocks;
    };
    return read(String(input.block_id), Number(input.depth ?? 1));
  }
  // One dispatch, never an SDK retry: an uncertain write requires review.
  const children = paragraphs(String(input.content ?? ""));
  if (action === "createPage")
    return page(
      await notionJson(
        "pages",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            parent: { page_id: input.pageId },
            properties: {
              title: {
                title: [{ type: "text", text: { content: input.title ?? "" } }],
              },
            },
            children,
          }),
        },
        request,
      ),
    );
  const result = await notionJson(
    "blocks/" + input.pageId + "/children",
    token,
    { method: "PATCH", body: JSON.stringify({ children }) },
    request,
  );
  const blocks = list(result);
  if (
    result.has_more ||
    blocks.length !== children.length ||
    blocks.some((b) => b.object !== "block" || !notionId(b.id))
  )
    throw new NotionRequestError(
      "Notion did not confirm all appended content. Check the page before trying again.",
    );
  return result;
}
