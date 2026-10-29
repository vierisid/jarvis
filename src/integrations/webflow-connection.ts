/** Read the hosting-owned grant on every use, including reconnects and disconnects. */
import { readManagedConnectionFile } from "./managed-connection-file";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const WEBFLOW_PIECE = "@activepieces/piece-webflow";
export const WEBFLOW_CONNECTION = "jarvis:webflow";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface WebflowConnection {
  version: 1;
  provider: "webflow";
  status: "connected";
  generation: string;
  access_token: string;
  account: { id: string; label: string };
  workspaces: Array<{ id: string; name: string }>;
  connected_at: string;
}
export function readWebflowConnection(
  dataDir: string,
): WebflowConnection | null {
  try {
    const v = JSON.parse(
      readManagedConnectionFile(join(dataDir, "connections", "webflow.json")),
    ) as WebflowConnection;
    if (
      v.version !== 1 ||
      v.provider !== "webflow" ||
      v.status !== "connected" ||
      typeof v.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(v.generation) ||
      typeof v.access_token !== "string" ||
      !v.access_token ||
      v.access_token.length > 16384 ||
      typeof v.account?.id !== "string" ||
      !/^[a-f0-9]{24}$/.test(v.account.id) ||
      typeof v.account.label !== "string" ||
      !v.account.label ||
      !Array.isArray(v.workspaces) ||
      !v.workspaces.length ||
      v.workspaces.length > 100 ||
      new Set(v.workspaces.map((w) => w.id)).size !== v.workspaces.length ||
      !v.workspaces.every(
        (w) =>
          typeof w.id === "string" &&
          /^[a-f0-9]{24}$/.test(w.id) &&
          typeof w.name === "string",
      ) ||
      typeof v.connected_at !== "string" ||
      !Number.isFinite(Date.parse(v.connected_at))
    )
      return null;
    return v;
  } catch {
    return null;
  }
}
/** This block is system-owned; UI settings cannot redirect account setup. */
export function webflowConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "webflow");
    return url.toString();
  } catch {
    return null;
  }
}
export function webflowStatus(config: JarvisConfig) {
  const connection = readWebflowConnection(config.daemon.data_dir);
  return {
    configured: !!webflowConnectUrl(config),
    connect_url: webflowConnectUrl(config),
    connected: !!connection,
    external_id: WEBFLOW_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
