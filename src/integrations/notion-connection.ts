import { notionNeedsReconnect } from "./notion-refresh";
/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import { readManagedConnectionFile } from "./managed-connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const NOTION_PIECE = "@activepieces/piece-notion";
export const NOTION_CONNECTION = "jarvis:notion";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface NotionConnection {
  version: 1;
  provider: "notion";
  status: "connected";
  generation: string;
  access_token: string;
  account: { id: string; label: string };
  workspaces: Array<{ id: string; name: string }>;
  connected_at: string;
  refresh_token: string;
  expires_at: string | null;
  refresh: { url: string; instance_id: string; secret: string };
}
export function readNotionConnection(dataDir: string): NotionConnection | null {
  try {
    const v = JSON.parse(
      readManagedConnectionFile(join(dataDir, "connections", "notion.json")),
    ) as NotionConnection;
    if (
      v.version !== 1 ||
      v.provider !== "notion" ||
      v.status !== "connected" ||
      typeof v.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(v.generation) ||
      typeof v.access_token !== "string" ||
      !v.access_token ||
      typeof v.account?.id !== "string" ||
      !v.account.id ||
      typeof v.account.label !== "string" ||
      !v.account.label ||
      !Array.isArray(v.workspaces) ||
      !v.workspaces.every(
        (w) => typeof w.id === "string" && !!w.id && typeof w.name === "string",
      ) ||
      typeof v.connected_at !== "string" ||
      typeof v.refresh_token !== "string" ||
      !v.refresh_token ||
      v.refresh_token.length > 16384 ||
      (v.expires_at !== null &&
        (typeof v.expires_at !== "string" ||
          !Number.isFinite(Date.parse(v.expires_at)))) ||
      typeof v.refresh?.url !== "string" ||
      typeof v.refresh.instance_id !== "string" ||
      typeof v.refresh.secret !== "string" ||
      !/^[a-f0-9]{64}$/.test(v.refresh.secret)
    )
      return null;
    return v;
  } catch {
    return null;
  }
}
/** This block is system-owned; UI settings cannot redirect account setup. */
export function notionConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "notion");
    return url.toString();
  } catch {
    return null;
  }
}
export function notionStatus(config: JarvisConfig) {
  const connection = readNotionConnection(config.daemon.data_dir);
  const reconnect = connection
    ? notionNeedsReconnect(config, connection)
    : false;
  return {
    configured: !!notionConnectUrl(config),
    connect_url: notionConnectUrl(config),
    connected: !!connection && !reconnect,
    reconnect,
    external_id: NOTION_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
