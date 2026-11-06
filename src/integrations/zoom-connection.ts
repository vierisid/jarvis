import { zoomNeedsReconnect } from "./zoom-refresh";
/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import { readConnectionFile } from "./connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";
import { hostedSetupFault } from "./hosted-setup";

export const ZOOM_PIECE = "@activepieces/piece-zoom";
export const ZOOM_CONNECTION = "jarvis:zoom";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface ZoomConnection {
  version: 1;
  provider: "zoom";
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
export function readZoomConnection(dataDir: string): ZoomConnection | null {
  try {
    const v = JSON.parse(
      readConnectionFile(join(dataDir, "connections", "zoom.json")),
    ) as ZoomConnection;
    if (
      v.version !== 1 ||
      v.provider !== "zoom" ||
      v.status !== "connected" ||
      typeof v.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(v.generation) ||
      typeof v.access_token !== "string" ||
      !v.access_token ||
      v.access_token.length > 16384 ||
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
export function zoomConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "zoom");
    return url.toString();
  } catch {
    return null;
  }
}
export function zoomStatus(config: JarvisConfig) {
  const connection = readZoomConnection(config.daemon.data_dir);
  const reconnect = connection ? zoomNeedsReconnect(config, connection) : false;
  return {
    configured: !!zoomConnectUrl(config),
    connect_url: zoomConnectUrl(config),
    ...hostedSetupFault(config, zoomConnectUrl(config)),
    connected: !!connection && !reconnect,
    reconnect,
    external_id: ZOOM_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
