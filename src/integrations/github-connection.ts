import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const GITHUB_PIECE = "@activepieces/piece-github";
export const GITHUB_CONNECTION = "jarvis:github";
export interface GitHubConnection {
  version: 1; provider: "github"; status: "connected"; generation: string;
  access_token: string; account: {id: string; label: string};
  workspaces: Array<{id: string; name: string}>; connected_at: string;
}
export function readGitHubConnection(dataDir: string): GitHubConnection | null {
  try {
    const path = join(dataDir, "connections", "github.json");
    if (statSync(path).size > 65536) return null;
    const v = JSON.parse(readFileSync(path, "utf8")) as GitHubConnection;
    if (v.version !== 1 || v.provider !== "github" || v.status !== "connected"
      || typeof v.generation !== "string" || !/^[a-f0-9-]{36}$/.test(v.generation)
      || typeof v.access_token !== "string" || !v.access_token || v.access_token.length > 16384
      || typeof v.account?.id !== "string" || !v.account.id
      || typeof v.account.label !== "string" || !v.account.label
      || !Array.isArray(v.workspaces) || v.workspaces.length > 1000
      || !v.workspaces.every(w => typeof w.id === "string" && !!w.id && typeof w.name === "string")
      || typeof v.connected_at !== "string") return null;
    return v;
  } catch { return null; }
}
/** This block is system-owned; UI settings cannot redirect account setup. */
export function githubConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "github");
    return url.toString();
  } catch { return null; }
}
export function githubStatus(config: JarvisConfig) {
  const connection = readGitHubConnection(config.daemon.data_dir);
  return {configured: !!githubConnectUrl(config), connect_url: githubConnectUrl(config),
    connected: !!connection, external_id: GITHUB_CONNECTION,
    account: connection?.account ?? null, workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null, connected_at: connection?.connected_at ?? null};
}
