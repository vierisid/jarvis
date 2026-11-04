import { createHash, randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JarvisConfig } from "../config/types";
import { readManagedConnectionFile } from "./managed-connection-file";
import {
  readWebflowConnection,
  type WebflowConnection,
} from "./webflow-connection";
import {
  WebflowRequestError,
  webflowRequest,
} from "../workflows/runtime/managed-webflow";

/**
 * Webflow tokens never expire and are never refreshed, so hosting cannot learn
 * that a customer uninstalled Jarvis in Webflow. The instance does: a 401 from
 * Webflow marks the delivered grant for reconnect here, and the mark lasts until
 * hosting delivers a different grant (a reconnect or a disconnect).
 */
export const webflowGrantKey = (c: WebflowConnection) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        c.generation,
        c.account.id,
        c.access_token,
        c.workspaces.map((w) => w.id),
      ]),
    )
    .digest("hex");
const markPath = (config: JarvisConfig) =>
  join(config.daemon.data_dir, "connections", "webflow-access.json");

export function webflowNeedsReconnect(
  config: JarvisConfig,
  c: WebflowConnection,
): boolean {
  try {
    const mark = JSON.parse(readManagedConnectionFile(markPath(config))) as {
      key?: unknown;
      reconnect?: unknown;
    };
    return mark.key === webflowGrantKey(c) && mark.reconnect === true;
  } catch {
    return false;
  }
}

/** Mark `c` for reconnect, unless hosting has delivered another grant meanwhile. */
export function recordWebflowRefusal(
  config: JarvisConfig,
  c: WebflowConnection,
): void {
  const live = readWebflowConnection(config.daemon.data_dir);
  if (!live || webflowGrantKey(live) !== webflowGrantKey(c)) return;
  const path = markPath(config),
    temp = path + "." + randomUUID();
  try {
    writeFileSync(
      temp,
      JSON.stringify({ key: webflowGrantKey(c), reconnect: true }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* already renamed */
    }
  }
  validated.delete(webflowGrantKey(c));
}

/** Grants Webflow accepted recently: a run of many steps checks once. */
const VALIDATED_TTL_MS = 60_000;
const validated = new Map<string, number>();

/**
 * Ask Webflow whether the grant still works before a workflow is handed it.
 * A 401 marks it for reconnect and throws; any other failure throws without a
 * mark, so throttling or an outage never asks the customer to reconnect.
 */
export async function assertWebflowAccess(
  config: JarvisConfig,
  c: WebflowConnection,
  request: typeof fetch = fetch,
): Promise<void> {
  const key = webflowGrantKey(c),
    now = Date.now();
  for (const [k, at] of validated)
    if (now - at > VALIDATED_TTL_MS) validated.delete(k);
  if (webflowNeedsReconnect(config, c))
    throw new Error("Reconnect Webflow in your account page.");
  if (validated.has(key)) return;
  let user: Record<string, unknown>;
  try {
    user = await webflowRequest(
      c.access_token,
      "/token/authorized_by",
      "GET",
      undefined,
      request,
    );
  } catch (error) {
    if (error instanceof WebflowRequestError && error.status === 401) {
      recordWebflowRefusal(config, c);
      throw new Error("Reconnect Webflow in your account page.");
    }
    throw error;
  }
  if (user.id !== c.account.id)
    throw new Error("Webflow account changed. Reconnect Webflow.");
  validated.set(key, now);
}
