/**
 * The hosted ClickUp connection. Hosting signs the person in on its account
 * page (`usejarvis_integrations.page_url`) and its worker atomically writes
 * `<data_dir>/connections/clickup.json`; the brain only reads that file, on
 * every use, so a reconnect (new `generation`) or a disconnect takes effect
 * with no restart. The file mode is the worker's to set and is not checked
 * here. "Connected" means a grant is stored, not that ClickUp still honours
 * it. ClickUp OAuth tokens do not expire today, so there is no refresh flow.
 * Status and metadata routes expose labels and state, never the token.
 */
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";
import { readConnectionFile } from "./connection-file";

export const CLICKUP_PIECE = "@activepieces/piece-clickup";
export const CLICKUP_CONNECTION = "jarvis:clickup";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface ClickUpConnection {
  version: 1; provider: "clickup"; status: "connected"; generation: string;
  access_token: string; account: {id: string; label: string};
  workspaces: Array<{id: string; name: string}>; connected_at: string;
}
export function readClickUpConnection(dataDir: string): ClickUpConnection | null {
  try {
    const v = JSON.parse(readConnectionFile(join(dataDir, "connections", "clickup.json"))) as ClickUpConnection;
    if (v.version !== 1 || v.provider !== "clickup" || v.status !== "connected"
      || typeof v.generation !== "string" || !/^[a-f0-9-]{36}$/.test(v.generation)
      || typeof v.access_token !== "string" || !v.access_token
      || typeof v.account?.id !== "string" || !v.account.id
      || typeof v.account.label !== "string" || !v.account.label
      || !Array.isArray(v.workspaces) || !v.workspaces.length
      || !v.workspaces.every(w => typeof w.id === "string" && !!w.id && typeof w.name === "string")
      || typeof v.connected_at !== "string") return null;
    return v;
  } catch { return null; }
}
/** This block is system-owned; UI settings cannot redirect account setup. */
export function clickUpConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "clickup");
    return url.toString();
  } catch { return null; }
}
export function clickUpStatus(config: JarvisConfig) {
  const connection = readClickUpConnection(config.daemon.data_dir);
  return {configured: !!clickUpConnectUrl(config), connect_url: clickUpConnectUrl(config),
    connected: !!connection, external_id: CLICKUP_CONNECTION,
    account: connection?.account ?? null, workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null, connected_at: connection?.connected_at ?? null};
}
