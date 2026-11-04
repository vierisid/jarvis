import type { JarvisConfig } from "../config/types";
import { readWebflowConnection } from "./webflow-connection";
import {
  webflowCollections,
  webflowCollectionContext,
  webflowId,
  WebflowRequestError,
} from "../workflows/runtime/managed-webflow";
import { recordWebflowRefusal } from "./webflow-access";
import { credentialFingerprint } from "../workflows/credentials/adapter";
export class WebflowOptionsInputError extends Error {}
export async function webflowOptions(
  config: JarvisConfig,
  query: URLSearchParams,
  request: typeof fetch = fetch,
) {
  const c = readWebflowConnection(config.daemon.data_dir);
  if (!c) throw new WebflowOptionsInputError("Connect Webflow first.");
  if (query.get("generation") !== c.generation)
    throw new WebflowOptionsInputError(
      "Your Webflow account changed. Reload the connection.",
    );
  let site: string, collection: string | null;
  try {
    site = webflowId(query.get("site"));
    collection = query.get("collection")
      ? webflowId(query.get("collection"))
      : null;
  } catch {
    throw new WebflowOptionsInputError(
      "Choose a valid Webflow site and collection.",
    );
  }
  if (!c.workspaces.some((w) => w.id === site))
    throw new WebflowOptionsInputError("Choose a connected Webflow site.");
  let result;
  try {
    result = collection
      ? await webflowCollectionContext(c.access_token, site, collection, request)
      : { collections: await webflowCollections(c.access_token, site, request) };
  } catch (error) {
    // A refused grant shows Reconnect on the card, as a refused run does.
    if (error instanceof WebflowRequestError && error.status === 401)
      recordWebflowRefusal(config, c);
    throw error;
  }
  const next = readWebflowConnection(config.daemon.data_dir);
  if (
    !next ||
    credentialFingerprint(JSON.stringify(next)) !==
      credentialFingerprint(JSON.stringify(c))
  )
    throw new WebflowOptionsInputError(
      "Your Webflow account changed. Reload the connection.",
    );
  return { ...result, generation: c.generation };
}
