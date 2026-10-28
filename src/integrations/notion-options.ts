import type { JarvisConfig } from "../config/types";
import { readNotionConnection } from "./notion-connection";
import { freshNotionConnection, notionGrantKey } from "./notion-refresh";
import {
  notionJson,
  notionPageTitle,
  notionId,
  NotionRequestError,
} from "../workflows/runtime/managed-notion";
export class NotionOptionsError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
export async function notionOptions(
  config: JarvisConfig,
  params: URLSearchParams,
  request: typeof fetch = fetch,
) {
  const c = readNotionConnection(config.daemon.data_dir);
  if (!c) throw new NotionOptionsError("Connect Notion first.", 409);
  if (params.has("generation") && params.get("generation") !== c.generation)
    throw new NotionOptionsError(
      "Notion account changed. Choose the page again.",
      409,
    );
  const query = params.get("query") ?? "";
  if (query.length > 2000)
    throw new NotionOptionsError("Search text is too long.", 400);
  try {
    const fresh = await freshNotionConnection(config, request);
    const raw = await notionJson(
      "search",
      fresh.access_token,
      {
        method: "POST",
        body: JSON.stringify({
          ...(query ? { query } : {}),
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 100,
        }),
      },
      request,
    );
    if (
      !Array.isArray(raw.results) ||
      raw.results.length > 100 ||
      typeof raw.has_more !== "boolean" ||
      !raw.results.every((p: any) => p?.object === "page" && notionId(p.id))
    )
      throw new NotionOptionsError("Notion returned invalid page choices.");
    const current = readNotionConnection(config.daemon.data_dir);
    if (!current || notionGrantKey(current) !== notionGrantKey(c))
      throw new NotionOptionsError(
        "Notion account changed. Choose the page again.",
        409,
      );
    return {
      options: raw.results.map((p: any) => ({
        id: p.id,
        name: notionPageTitle(p) || "Untitled page",
      })),
      has_more: raw.has_more,
      generation: c.generation,
    };
  } catch (e) {
    if (e instanceof NotionOptionsError) throw e;
    throw new NotionOptionsError(
      e instanceof NotionRequestError
        ? e.message
        : "Could not load shared Notion pages. Check the connection and try again.",
      e instanceof NotionRequestError ? e.status : 502,
    );
  }
}
