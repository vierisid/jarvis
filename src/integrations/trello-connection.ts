import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const TRELLO_PIECE = "@activepieces/piece-trello";
export const TRELLO_CONNECTION = "jarvis:trello";
export interface TrelloConnection {
  version: 1; provider: "trello"; status: "connected"; generation: string;
  api_key: string;
  access_token: string; account: {id: string; label: string};
  workspaces: Array<{id: string; name: string}>; connected_at: string;
}
export function readTrelloConnection(dataDir: string): TrelloConnection | null {
  try {
    const path = join(dataDir, "connections", "trello.json");
    if (statSync(path).size > 65536) return null;
    const v = JSON.parse(readFileSync(path, "utf8")) as TrelloConnection;
    if (v.version !== 1 || v.provider !== "trello" || v.status !== "connected"
      || typeof v.generation !== "string" || !/^[a-f0-9-]{36}$/.test(v.generation)
      || typeof v.access_token !== "string" || !v.access_token || v.access_token.length > 16384
      || typeof v.account?.id !== "string" || !v.account.id
      || typeof v.account.label !== "string" || !v.account.label
      || typeof v.api_key !== "string" || !v.api_key || v.api_key.length > 512
      || !/^[a-f0-9]{24}$/.test(v.account.id)
      || !Array.isArray(v.workspaces) || v.workspaces.length > 1000
      || !v.workspaces.every(w => typeof w.id === "string" && /^[a-f0-9]{24}$/.test(w.id) && typeof w.name === "string")
      || typeof v.connected_at !== "string") return null;
    return v;
  } catch { return null; }
}
/** This block is system-owned; UI settings cannot redirect account setup. */
export function trelloConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "trello");
    return url.toString();
  } catch { return null; }
}
export function trelloStatus(config: JarvisConfig) {
  const connection = readTrelloConnection(config.daemon.data_dir);
  return {configured: !!trelloConnectUrl(config), connect_url: trelloConnectUrl(config),
    connected: !!connection, external_id: TRELLO_CONNECTION,
    account: connection?.account ?? null, workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null, connected_at: connection?.connected_at ?? null};
}
