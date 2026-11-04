import { mondayNeedsReconnect } from "./monday-refresh";
/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import { readManagedConnectionFile } from "./managed-connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const MONDAY_PIECE = "@activepieces/piece-monday";
export const MONDAY_CONNECTION = "jarvis:monday";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface MondayConnection {
  version: 1;
  provider: "monday";
  status: "connected";
  generation: string;
  access_token: string;
  account: { id: string; label: string };
  workspaces: Array<{ id: string; name: string }>;
  connected_at: string;
  refresh_token: string;
  expires_at: string;
  refresh: { url: string; instance_id: string; secret: string };
}
export function readMondayConnection(dataDir: string): MondayConnection | null {
  try {
    const v = JSON.parse(
      readManagedConnectionFile(join(dataDir, "connections", "monday.json")),
    ) as MondayConnection;
    if (
      v.version !== 1 ||
      v.provider !== "monday" ||
      v.status !== "connected" ||
      typeof v.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(v.generation) ||
      typeof v.access_token !== "string" ||
      !v.access_token ||
      v.access_token.length > 16384 ||
      typeof v.account?.id !== "string" ||
      !/^[1-9][0-9]{0,29}:[1-9][0-9]{0,29}$/.test(v.account.id) ||
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
export function mondayConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "monday");
    return url.toString();
  } catch {
    return null;
  }
}
export function mondayStatus(config: JarvisConfig) {
  const connection = readMondayConnection(config.daemon.data_dir);
  const reconnect = connection
    ? mondayNeedsReconnect(config, connection)
    : false;
  return {
    configured: !!mondayConnectUrl(config),
    connect_url: mondayConnectUrl(config),
    connected: !!connection && !reconnect,
    reconnect,
    external_id: MONDAY_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
