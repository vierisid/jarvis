/**
 * A flow's read list (#1153): the hosts an HTTP step's GET or HEAD may reach
 * without asking. Pure, no database access, so the schema migration that
 * grandfathers existing flows and the repo that reads the list can both use it
 * without an import cycle through `db/index.ts`.
 *
 * A body-less GET counts as a read, but it still carries whatever its URL and
 * headers hold to the host it names, so a flow that fills a URL at run time
 * could carry data out in a query string. The read list is the owner's answer:
 * a GET or HEAD to a listed host runs as a read, one to any other host asks as
 * a send. It is granted per flow by a person (`POST /api/workflows/:id/read-hosts`),
 * never by a flow edit or by `manage_workflow`.
 */

import { readHostKey } from "../runtime/http-egress";
import { walkFlowNodes } from "./flow-graph";
import type { FlowTriggerNode } from "./repos/flow-version";

/** The HTTP piece and its request action, as a step names them. */
const HTTP_PIECE = "@activepieces/piece-http";
const HTTP_ACTION = "send_request";

/**
 * Most hosts one flow may list. A list is typed by a person, one host per
 * API, and the grandfathering seeds one per literal-host GET step; 64 is far
 * past any flow the product builds and keeps the column and the card small.
 */
export const MAX_READ_HOSTS = 64;

/** Who wrote the list: a person (`user`) or the upgrade that introduced it (`upgrade`). */
export type ReadHostsGrant = "user" | "upgrade";

/**
 * Normalize a list a person sent: each entry in `readHostKey` form, sorted and
 * deduplicated. Throws naming the first entry that is not a bare host.
 */
export function normalizeReadHosts(hosts: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const h of hosts) {
    const key = readHostKey(h);
    if (key === null) throw new Error(`${JSON.stringify(h)} is not a host name: give a bare host such as api.example.com, with no scheme, port, path or wildcard (an IPv6 address in brackets, [2001:db8::1])`);
    out.add(key);
  }
  if (out.size > MAX_READ_HOSTS) throw new Error(`a flow may list at most ${MAX_READ_HOSTS} hosts`);
  return [...out].sort();
}

/** The stored list, or [] for NULL or anything unreadable. */
export function parseReadHosts(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((h) => readHostKey(h)).filter((h): h is string => h !== null))].sort();
  } catch {
    return [];
  }
}

/** The list as a flow row (`SELECT *`) carries it, without another query. */
export function readHostsOfRow(row: Record<string, unknown>): { hosts: string[]; grantedBy: ReadHostsGrant | null; grantedAt: number | null } {
  const grant = row.read_hosts_grant === "user" || row.read_hosts_grant === "upgrade" ? row.read_hosts_grant : null;
  return { hosts: parseReadHosts(typeof row.read_hosts === "string" ? row.read_hosts : null), grantedBy: grant,
    grantedAt: typeof row.read_hosts_granted_at === "number" ? row.read_hosts_granted_at : null };
}

/**
 * The host of a URL whose scheme and host are written out, with no template
 * (`{{...}}`) before the path: the hosts a person put in the flow, as opposed
 * to ones filled in at run time. Null otherwise.
 */
function literalHost(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = /^\s*https?:\/\/([^/?#\\]*)/iu.exec(url);
  if (!m || m[1]!.includes("{{") || m[1]!.includes("}}") || m[1]!.includes("@")) return null;
  let parsed: URL;
  try {
    parsed = new URL(`http://${m[1]}/`);
  } catch {
    return null;
  }
  return readHostKey(parsed.hostname);
}

/**
 * Hosts the grandfathering seeds for a flow: the literal host of every HTTP
 * request step whose method is a literal GET or HEAD, or not set, and of every
 * literal file URL in an HTTP step's form data (`literalFileHosts`). A step whose
 * method or host is filled at run time seeds nothing, so a host an attacker
 * could choose is never listed by the upgrade.
 */
export function literalReadHosts(root: FlowTriggerNode | null | undefined): string[] {
  const out = new Set<string>();
  for (const node of walkFlowNodes(root)) {
    const settings = (node as { settings?: unknown }).settings;
    if (!settings || typeof settings !== "object") continue;
    const s = settings as { pieceName?: unknown; actionName?: unknown; input?: unknown };
    if (s.pieceName !== HTTP_PIECE || s.actionName !== HTTP_ACTION) continue;
    const input = s.input && typeof s.input === "object" ? (s.input as Record<string, unknown>) : {};
    const method = input.method;
    if (method !== undefined && method !== null && !(typeof method === "string" && /^(get|head)$/iu.test(method))) continue;
    const host = literalHost(input.url);
    if (host) out.add(host);
  }
  for (const host of literalFileHosts(root)) out.add(host);
  return [...out].sort().slice(0, MAX_READ_HOSTS);
}

/**
 * Hosts of the literal URLs in HTTP steps' form-data file fields (#1153). The
 * engine fetches a file field before its step is approved, holding it to the
 * read list; a flow that already attached a file from a URL a person wrote
 * keeps doing so after the upgrade. Any method: the download is a GET
 * whatever the step then sends. Other pieces' file properties are not known
 * to the schema migration and are not seeded.
 */
export function literalFileHosts(root: FlowTriggerNode | null | undefined): string[] {
  const out = new Set<string>();
  for (const node of walkFlowNodes(root)) {
    const s = (node as { settings?: { pieceName?: unknown; actionName?: unknown; input?: unknown } }).settings;
    if (!s || s.pieceName !== HTTP_PIECE || s.actionName !== HTTP_ACTION) continue;
    const body = s.input && typeof s.input === "object" ? (s.input as { body?: unknown }).body : undefined;
    const rows = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const field = row as { fieldType?: unknown; fileFieldValue?: unknown };
      if (field.fieldType !== "file") continue;
      const host = literalHost(field.fileFieldValue);
      if (host) out.add(host);
    }
  }
  return [...out].sort();
}
