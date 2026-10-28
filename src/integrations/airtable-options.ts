import type { JarvisConfig } from "../config/types";
import { readAirtableConnection } from "./airtable-connection";
import { freshAirtableConnection } from "./airtable-refresh";
import {
  airtableJson,
  airtableId,
  airtableTables,
  AirtableRequestError,
  type AirtableTable,
} from "../workflows/runtime/managed-airtable";
export class AirtableOptionsError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
export async function airtableOptions(
  config: JarvisConfig,
  params: URLSearchParams,
  request: typeof fetch = fetch,
) {
  const initial = readAirtableConnection(config.daemon.data_dir);
  if (!initial)
    throw new AirtableOptionsError(
      "Connect Airtable before choosing a base.",
      409,
    );
  const base = params.get("base");
  if (base && !airtableId(base, "app"))
    throw new AirtableOptionsError("Choose a valid base.", 400);
  if (
    params.get("generation") &&
    params.get("generation") !== initial.generation
  )
    throw new AirtableOptionsError(
      "Airtable account changed. Reload bases.",
      409,
    );
  try {
    const c = await freshAirtableConnection(config, request);
    let result: {
      options?: Array<{ value: string; label: string }>;
      tables?: AirtableTable[];
    };
    if (base)
      result = { tables: await airtableTables(base, c.access_token, request) };
    else {
      const options: Array<{ value: string; label: string }> = [];
      const seen = new Set<string>();
      let offset = "";
      for (let page = 0; page < 10; page++) {
        const raw = (await airtableJson(
          "meta/bases" +
            (offset ? "?offset=" + encodeURIComponent(offset) : ""),
          c.access_token,
          {},
          request,
        )) as {
          bases?: Array<{ id?: unknown; name?: unknown }>;
          offset?: unknown;
        };
        if (!Array.isArray(raw?.bases) || raw.bases.length > 1000)
          throw new Error();
        for (const b of raw.bases) {
          if (!airtableId(b.id, "app") || typeof b.name !== "string")
            throw new Error();
          options.push({ value: b.id as string, label: b.name });
        }
        if (raw.offset === undefined) {
          offset = "";
          break;
        }
        if (
          typeof raw.offset !== "string" ||
          !raw.offset ||
          raw.offset.length > 1024 ||
          seen.has(raw.offset)
        )
          throw new Error();
        offset = raw.offset;
        seen.add(offset);
      }
      if (offset)
        throw new AirtableOptionsError(
          "Too many bases to list. Enter a base ID instead.",
          422,
        );
      result = { options };
    }
    if (
      readAirtableConnection(config.daemon.data_dir)?.generation !==
        initial.generation ||
      c.generation !== initial.generation
    )
      throw new AirtableOptionsError(
        "Airtable account changed. Reload bases.",
        409,
      );
    return { ...result, generation: c.generation };
  } catch (e) {
    if (e instanceof AirtableOptionsError) throw e;
    if (e instanceof AirtableRequestError)
      throw new AirtableOptionsError(
        e.message,
        [401, 403].includes(e.status) ? 409 : e.status,
      );
    throw new AirtableOptionsError(
      "Could not load Airtable choices. Check the connection and try again.",
    );
  }
}
