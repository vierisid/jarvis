import { wrikeNeedsReconnect } from "./wrike-refresh";
/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import { readManagedConnectionFile } from "./managed-connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const WRIKE_PIECE = "@activepieces/piece-wrike";
export const WRIKE_CONNECTION = "jarvis:wrike";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface WrikeConnection {
  version: 1;
  provider: "wrike";
  status: "connected";
  generation: string;
  access_token: string;
  account: { id: string; label: string };
  workspaces: Array<{ id: string; name: string }>;
  settings: { api_host: string };
  definition: { allowedApiHosts: string[] };
  connected_at: string;
  refresh_token: string;
  expires_at: string;
  refresh: { url: string; instance_id: string; secret: string };
}
export function readWrikeConnection(dataDir: string): WrikeConnection | null {
  try {
    const v = JSON.parse(
      readManagedConnectionFile(join(dataDir, "connections", "wrike.json")),
    ) as WrikeConnection;
    if (
      v.version !== 1 ||
      v.provider !== "wrike" ||
      v.status !== "connected" ||
      typeof v.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(v.generation) ||
      typeof v.access_token !== "string" ||
      !v.access_token ||
      v.access_token.length > 16384 ||
      typeof v.account?.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(v.account.id) ||
      typeof v.account.label !== "string" ||
      !v.account.label ||
      !["www.wrike.com", "app-us2.wrike.com", "app-eu.wrike.com"].includes(
        v.settings?.api_host,
      ) ||
      !Array.isArray(v.definition?.allowedApiHosts) ||
      v.definition.allowedApiHosts.length !== 1 ||
      v.definition.allowedApiHosts[0] !== v.settings.api_host ||
      !Array.isArray(v.workspaces) ||
      v.workspaces.length !== 1 ||
      !v.workspaces.every(
        (w) => typeof w.id === "string" && !!w.id && typeof w.name === "string",
      ) ||
      typeof v.connected_at !== "string" ||
      typeof v.refresh_token !== "string" ||
      !v.refresh_token ||
      v.refresh_token.length > 16384 ||
      !Number.isFinite(Date.parse(v.expires_at)) ||
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
export function wrikeConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "wrike");
    return url.toString();
  } catch {
    return null;
  }
}
export function wrikeStatus(config: JarvisConfig) {
  const connection = readWrikeConnection(config.daemon.data_dir);
  const reconnect = connection
    ? wrikeNeedsReconnect(config, connection)
    : false;
  return {
    configured: !!wrikeConnectUrl(config),
    connect_url: wrikeConnectUrl(config),
    connected: !!connection && !reconnect,
    reconnect,
    external_id: WRIKE_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
