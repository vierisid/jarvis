import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";

export const MAILCHIMP_PIECE = "@activepieces/piece-mailchimp";
export const MAILCHIMP_CONNECTION = "jarvis:mailchimp";
export interface MailchimpConnection {
  version: 1; provider: "mailchimp"; status: "connected"; generation: string;
  server_prefix: string;
  access_token: string; account: {id: string; label: string};
  workspaces: Array<{id: string; name: string}>; connected_at: string;
}
export function readMailchimpConnection(dataDir: string): MailchimpConnection | null {
  try {
    const path = join(dataDir, "connections", "mailchimp.json");
    if (statSync(path).size > 65536) return null;
    const v = JSON.parse(readFileSync(path, "utf8")) as MailchimpConnection;
    if (v.version !== 1 || v.provider !== "mailchimp" || v.status !== "connected"
      || typeof v.generation !== "string" || !/^[a-f0-9-]{36}$/.test(v.generation)
      || typeof v.access_token !== "string" || !v.access_token || v.access_token.length > 16384
      || typeof v.account?.id !== "string" || !v.account.id
      || typeof v.account.label !== "string" || !v.account.label
      || typeof v.server_prefix !== "string" || !/^us[1-9][0-9]{0,3}$/.test(v.server_prefix)
      || !Array.isArray(v.workspaces) || v.workspaces.length > 1000
      || !v.workspaces.every(w => typeof w.id === "string" && !!w.id && typeof w.name === "string")
      || typeof v.connected_at !== "string") return null;
    return v;
  } catch { return null; }
}
/** This block is system-owned; UI settings cannot redirect account setup. */
export function mailchimpConnectUrl(config: JarvisConfig): string | null {
  const value = config.usejarvis_integrations?.page_url;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.searchParams.set("integration", "mailchimp");
    return url.toString();
  } catch { return null; }
}
export function mailchimpStatus(config: JarvisConfig) {
  const connection = readMailchimpConnection(config.daemon.data_dir);
  return {configured: !!mailchimpConnectUrl(config), connect_url: mailchimpConnectUrl(config),
    connected: !!connection, external_id: MAILCHIMP_CONNECTION,
    account: connection?.account ?? null, workspaces: connection?.workspaces ?? [],
    generation: connection?.generation ?? null, connected_at: connection?.connected_at ?? null};
}
