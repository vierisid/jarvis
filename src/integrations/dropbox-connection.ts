/** Read the hosting-owned grant on every use. Refreshed access tokens are cached separately. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const DROPBOX_PIECE = "@activepieces/piece-dropbox";
export const DROPBOX_CONNECTION = "jarvis:dropbox";
/** The file's shape (`version: 1`); anything else reads as not connected. */
export interface DropboxConnection {
  version: 1;
  provider: "dropbox";
  status: "connected";
  generation: string;
  access_token: string;
  account: { id: string; label: string };
  workspaces: Array<{ id: string; name: string }>;
  connected_at: string;
  refresh_token: string;
  expires_at: string;
  refresh: { url: string; instance_id: string; secret: string };
  settings: { home_namespace_id: string };
}
const MAX_CONNECTION_BYTES = 65536;
/**
 * The file's text, read through one descriptor: a FIFO or device would block
 * this synchronous read (and the daemon with it), and a size checked by path
 * could change before the read, so the open never blocks, the descriptor must
 * be a regular file, and no more than the cap is read.
 */
export function readDropboxBounded(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(MAX_CONNECTION_BYTES + 1);
    let size = 0;
    for (
      let n;
      size < buffer.length &&
      (n = readSync(fd, buffer, size, buffer.length - size, null)) > 0;
    )
      size += n;
    if (size > MAX_CONNECTION_BYTES) throw new Error("too large");
    return buffer.toString("utf8", 0, size);
  } finally {
    closeSync(fd);
  }
}
export function readDropboxConnection(
  dataDir: string,
): DropboxConnection | null {
  try {
    const v = JSON.parse(
      readDropboxBounded(join(dataDir, "connections", "dropbox.json")),
    ) as DropboxConnection;
    if (
      v.version !== 1 ||
      v.provider !== "dropbox" ||
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
      !/^[a-f0-9]{64}$/.test(v.refresh.secret) ||
      typeof v.settings?.home_namespace_id !== "string" ||
      !/^[0-9]+$/.test(v.settings.home_namespace_id)
    )
      return null;
    return v;
  } catch {
    return null;
  }
}
/** This block is system-owned; UI settings cannot redirect account setup. */
export function dropboxConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "dropbox");
    return url.toString();
  } catch {
    return null;
  }
}
export function dropboxStatus(config: JarvisConfig) {
  const connection = readDropboxConnection(config.daemon.data_dir);
  return {
    configured: !!dropboxConnectUrl(config),
    connect_url: dropboxConnectUrl(config),
    connected: !!connection,
    external_id: DROPBOX_CONNECTION,
    account: connection?.account ?? null,
    workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null,
    connected_at: connection?.connected_at ?? null,
  };
}
