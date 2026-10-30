/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import {readManagedConnectionFile} from "./managed-connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const ASANA_PIECE = "@activepieces/piece-asana";
export const ASANA_CONNECTION = "jarvis:asana";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface AsanaConnection {
  version: 1;
  provider: "asana";
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
export function readAsanaConnection(
  dataDir: string,
): AsanaConnection | null {
  try {
    const v = JSON.parse(
      readManagedConnectionFile(join(dataDir, "connections", "asana.json")),
    ) as AsanaConnection;
    if (
      v.version !== 1 ||
      v.provider !== "asana" ||
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
      !v.workspaces.length ||
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
export function asanaConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "asana");
    return url.toString();
  } catch {
    return null;
  }
}
export function asanaStatus(config: JarvisConfig) {
  const connection = readAsanaConnection(config.daemon.data_dir);
  return {
    configured: !!asanaConnectUrl(config),
    connect_url: asanaConnectUrl(config),
    connected: !!connection,
    external_id: ASANA_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
