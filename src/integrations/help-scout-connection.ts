import { helpScoutNeedsReconnect } from "./help-scout-refresh";
/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import { readConnectionFile } from "./connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const HELP_SCOUT_PIECE = "@activepieces/piece-help-scout";
export const HELP_SCOUT_CONNECTION = "jarvis:help-scout";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface HelpScoutConnection {
  version: 1;
  provider: "help-scout";
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
export function readHelpScoutConnection(
  dataDir: string,
): HelpScoutConnection | null {
  try {
    const v = JSON.parse(
      readConnectionFile(join(dataDir, "connections", "help-scout.json")),
    ) as HelpScoutConnection;
    if (
      v.version !== 1 ||
      v.provider !== "help-scout" ||
      v.status !== "connected" ||
      typeof v.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(v.generation) ||
      typeof v.access_token !== "string" ||
      !v.access_token ||
      v.access_token.length > 16384 ||
      typeof v.account?.id !== "string" ||
      !/^[1-9][0-9]{0,15}$/.test(v.account.id) ||
      !Number.isSafeInteger(Number(v.account.id)) ||
      typeof v.account.label !== "string" ||
      !v.account.label ||
      v.account.label.length > 512 ||
      /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v.account.label) ||
      !Array.isArray(v.workspaces) ||
      !v.workspaces.every(
        (w) => typeof w.id === "string" && !!w.id && typeof w.name === "string",
      ) ||
      typeof v.connected_at !== "string" ||
      !Number.isFinite(Date.parse(v.connected_at)) ||
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
export function helpScoutConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "help-scout");
    return url.toString();
  } catch {
    return null;
  }
}
export function helpScoutStatus(config: JarvisConfig) {
  const connection = readHelpScoutConnection(config.daemon.data_dir);
  const reconnect = connection
    ? helpScoutNeedsReconnect(config, connection)
    : false;
  return {
    configured: !!helpScoutConnectUrl(config),
    connect_url: helpScoutConnectUrl(config),
    connected: !!connection && !reconnect,
    reconnect,
    external_id: HELP_SCOUT_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
