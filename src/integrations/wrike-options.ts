import type { JarvisConfig } from "../config/types";
import { freshWrikeConnection } from "./wrike-refresh";
import { wrikeFolderPage } from "../workflows/runtime/managed-wrike";
export class WrikeOptionsInputError extends Error {}
export async function wrikeFolderOptions(
  config: JarvisConfig,
  title: string | null,
  cursor: string | null,
  request: typeof fetch = fetch,
) {
  if (
    !title?.trim() ||
    title.length > 200 ||
    /[\x00-\x1f\x7f]/.test(title) ||
    (cursor && (cursor.length > 4096 || /[\x00-\x1f\x7f]/.test(cursor)))
  )
    throw new WrikeOptionsInputError(
      "Enter a folder or project name to search.",
    );
  const c = await freshWrikeConnection(config, request);
  return wrikeFolderPage(
    { access_token: c.access_token, api_host: c.settings.api_host },
    title,
    cursor,
    request,
  );
}
