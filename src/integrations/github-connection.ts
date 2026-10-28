import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const GITHUB_PIECE = "@activepieces/piece-github";
export const GITHUB_CONNECTION = "jarvis:github";
/**
 * Written by the hosting worker as connections/github.json (mode 0600) and
 * replaced atomically on reconnect; disconnect leaves a non-connected
 * tombstone. The token comes from a GitHub OAuth App with the repo scope,
 * which includes private code: the managed action allowlist limits what
 * Jarvis dispatches, not what the token can do. Expiring tokens are rejected
 * on hosting, so there is no refresh path.
 */
export interface GitHubConnection {
  version: 1; provider: "github"; status: "connected"; generation: string;
  access_token: string; account: {id: string; label: string};
  workspaces: Array<{id: string; name: string}>; connected_at: string;
}
const MAX_CONNECTION_BYTES = 65536;
/**
 * The file's text, read through one descriptor: a FIFO or device would block
 * this synchronous read (and the daemon with it), and a size checked by path
 * could change before the read, so the open never blocks, the descriptor must
 * be a regular file, and no more than the cap is read.
 */
function readBounded(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(MAX_CONNECTION_BYTES + 1);
    let size = 0;
    for (let n; size < buffer.length && (n = readSync(fd, buffer, size, buffer.length - size, null)) > 0;) size += n;
    if (size > MAX_CONNECTION_BYTES) throw new Error("too large");
    return buffer.toString("utf8", 0, size);
  } finally { closeSync(fd); }
}
export function readGitHubConnection(dataDir: string): GitHubConnection | null {
  try {
    const v = JSON.parse(readBounded(join(dataDir, "connections", "github.json"))) as GitHubConnection;
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
