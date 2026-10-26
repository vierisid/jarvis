import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const SLACK_PIECE = "@activepieces/piece-slack";
export const SLACK_CONNECTION = "jarvis:slack";
export interface SlackConnection {
  version: 1; provider: "slack"; status: "connected"; generation: string;
  scopes: string[];
  access_token: string; account: {id: string; label: string};
  workspaces: Array<{id: string; name: string}>; connected_at: string;
}
export function readSlackConnection(dataDir: string): SlackConnection | null {
  try {
    const path = join(dataDir, "connections", "slack.json");
    if (statSync(path).size > 65536) return null;
    const v = JSON.parse(readFileSync(path, "utf8")) as SlackConnection;
    if (v.version !== 1 || v.provider !== "slack" || v.status !== "connected"
      || typeof v.generation !== "string" || !/^[a-f0-9-]{36}$/.test(v.generation)
      || typeof v.access_token !== "string" || !v.access_token
      || typeof v.account?.id !== "string" || !v.account.id
      || typeof v.account.label !== "string" || !v.account.label
      || !Array.isArray(v.scopes) || [...v.scopes].sort().join(',') !== 'channels:read,chat:write,groups:read'
      || !/^[UW][A-Z0-9]+$/.test(v.account.id)
      || !Array.isArray(v.workspaces) || v.workspaces.length !== 1
      || !v.workspaces.every(w => typeof w.id === "string" && /^T[A-Z0-9]+$/.test(w.id) && typeof w.name === "string")
      || typeof v.connected_at !== "string") return null;
    return v;
  } catch { return null; }
}
/** This block is system-owned; UI settings cannot redirect account setup. */
export function slackConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "slack");
    return url.toString();
  } catch { return null; }
}
export function slackStatus(config: JarvisConfig) {
  const connection = readSlackConnection(config.daemon.data_dir);
  return {configured: !!slackConnectUrl(config), connect_url: slackConnectUrl(config),
    connected: !!connection, external_id: SLACK_CONNECTION,
    account: connection?.account ?? null, workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null, connected_at: connection?.connected_at ?? null};
}
