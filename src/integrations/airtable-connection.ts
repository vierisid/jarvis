import { airtableNeedsReconnect } from "./airtable-refresh";
/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import { readManagedConnectionFile } from "./managed-connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const AIRTABLE_PIECE = "@activepieces/piece-airtable";
export const AIRTABLE_CONNECTION = "jarvis:airtable";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface AirtableConnection {
  version: 1;
  provider: "airtable";
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
export function readAirtableConnection(
  dataDir: string,
): AirtableConnection | null {
  try {
    const v = JSON.parse(
      readManagedConnectionFile(join(dataDir, "connections", "airtable.json")),
    ) as AirtableConnection;
    if (
      v.version !== 1 ||
      v.provider !== "airtable" ||
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
export function airtableConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "airtable");
    return url.toString();
  } catch {
    return null;
  }
}
export function airtableStatus(config: JarvisConfig) {
  const connection = readAirtableConnection(config.daemon.data_dir);
  const reconnect = connection
    ? airtableNeedsReconnect(config, connection)
    : false;
  return {
    configured: !!airtableConnectUrl(config),
    connect_url: airtableConnectUrl(config),
    connected: !!connection && !reconnect,
    reconnect,
    external_id: AIRTABLE_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
