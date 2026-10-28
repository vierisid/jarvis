import { calendlyNeedsReconnect } from "./calendly-refresh";
/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import { readManagedConnectionFile } from "./managed-connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const CALENDLY_PIECE = "@activepieces/piece-calendly";
export const CALENDLY_CONNECTION = "jarvis:calendly";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface CalendlyConnection {
  version: 1;
  provider: "calendly";
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
export function readCalendlyConnection(
  dataDir: string,
): CalendlyConnection | null {
  try {
    const v = JSON.parse(
      readManagedConnectionFile(join(dataDir, "connections", "calendly.json")),
    ) as CalendlyConnection;
    if (
      v.version !== 1 ||
      v.provider !== "calendly" ||
      v.status !== "connected" ||
      typeof v.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(v.generation) ||
      typeof v.access_token !== "string" ||
      !v.access_token ||
      typeof v.account?.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(v.account.id) ||
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
export function calendlyConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "calendly");
    return url.toString();
  } catch {
    return null;
  }
}
export function calendlyStatus(config: JarvisConfig) {
  const connection = readCalendlyConnection(config.daemon.data_dir);
  const reconnect = connection
    ? calendlyNeedsReconnect(config, connection)
    : false;
  return {
    configured: !!calendlyConnectUrl(config),
    connect_url: calendlyConnectUrl(config),
    connected: !!connection && !reconnect,
    reconnect,
    external_id: CALENDLY_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
