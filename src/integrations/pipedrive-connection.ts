/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import { pipedriveNeedsReconnect } from "./pipedrive-refresh";
import { readManagedConnectionFile } from "./managed-connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";
import { hostedSetupFault } from "./hosted-setup";

export const PIPEDRIVE_PIECE = "@activepieces/piece-pipedrive";
export const PIPEDRIVE_CONNECTION = "jarvis:pipedrive";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface PipedriveConnection {
  version: 1;
  provider: "pipedrive";
  status: "connected";
  generation: string;
  access_token: string;
  account: { id: string; label: string };
  workspaces: Array<{ id: string; name: string }>;
  settings: { api_host: string; company_id: string };
  definition: { allowedApiHosts: string[] };
  connected_at: string;
  refresh_token: string;
  expires_at: string;
  refresh: { url: string; instance_id: string; secret: string };
}
export function readPipedriveConnection(
  dataDir: string,
): PipedriveConnection | null {
  try {
    const v = JSON.parse(
      readManagedConnectionFile(join(dataDir, "connections", "pipedrive.json")),
    ) as PipedriveConnection;
    if (
      v.version !== 1 ||
      v.provider !== "pipedrive" ||
      v.status !== "connected" ||
      typeof v.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(v.generation) ||
      typeof v.access_token !== "string" ||
      !v.access_token ||
      v.access_token.length > 16384 ||
      typeof v.account?.id !== "string" ||
      !/^[1-9][0-9]*:[1-9][0-9]*$/.test(v.account.id) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pipedrive\.com$/.test(
        v.settings?.api_host ?? "",
      ) ||
      !/^[1-9][0-9]*$/.test(v.settings?.company_id ?? "") ||
      v.account.id.split(":")[0] !== v.settings.company_id ||
      !Array.isArray(v.definition?.allowedApiHosts) ||
      v.definition.allowedApiHosts.length !== 1 ||
      v.definition.allowedApiHosts[0] !== v.settings.api_host ||
      typeof v.account.label !== "string" ||
      !v.account.label ||
      !Array.isArray(v.workspaces) ||
      v.workspaces.length !== 1 ||
      v.workspaces[0]?.id !== v.settings.company_id ||
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
export function pipedriveConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "pipedrive");
    return url.toString();
  } catch {
    return null;
  }
}
export function pipedriveStatus(config: JarvisConfig) {
  const connection = readPipedriveConnection(config.daemon.data_dir);
  const reconnect = connection
    ? pipedriveNeedsReconnect(config, connection)
    : false;
  return {
    configured: !!pipedriveConnectUrl(config),
    connect_url: pipedriveConnectUrl(config),
    ...hostedSetupFault(config, pipedriveConnectUrl(config)),
    connected: !!connection && !reconnect,
    reconnect,
    external_id: PIPEDRIVE_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
