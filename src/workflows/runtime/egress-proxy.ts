/**
 * The workflow engine's egress proxy (#1153).
 *
 * WHY. The per-step guards (http-egress.ts) cover the HTTP, GraphQL, SMTP and
 * SFTP steps and the engine's file download. A community piece's own HTTP
 * client, or a CODE step's `fetch`, connects wherever it is pointed: the
 * cloud metadata service, the daemon's own address, a private network on a
 * hosted install. The engine therefore starts with HTTP_PROXY and HTTPS_PROXY
 * pointing here, and every client that honours them (Bun's fetch, axios, and
 * so most pieces) is held to the same rule: `destinationAllowed`, under the
 * install's policy and with the machine's own addresses refused.
 *
 * HOW. A forward proxy on 127.0.0.1. `CONNECT host:port` (https) and
 * absolute-form requests (`GET http://host/path`, plain http) are both
 * resolved here once; every address the name resolves to must be allowed, and
 * the connection goes to the address that was checked, so a name that
 * resolves differently a second time changes nothing. The one exception is
 * the daemon's sandbox API, which the engine and its pieces call by design
 * (`allowLocal`). A refusal answers 403 with `X-Jarvis-Egress: refused` and
 * a reason; nothing is sent to the destination.
 *
 * WHAT IT DOES NOT COVER. Code that ignores the proxy env: Bun's node:http and
 * node:https without an agent, WebSockets, raw sockets (node:net, node:tls),
 * UDP. The per-step guards still apply to their steps; anything else reaches
 * the network directly. Hosted operators should also block link-local
 * addresses at the network layer (docs/SELF_HOSTING.md).
 */

import { lookup as dnsLookup } from "node:dns";
import { connect as netConnect, createServer, isIP, type AddressInfo, type Server, type Socket } from "node:net";
import { canonicalAddress, destinationAllowed, ownAddresses, type EgressPolicy } from "./http-egress";

/** All addresses of a name, as `dns.lookup(name, { all: true })` gives them. */
export type ResolveAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface EgressProxyOptions {
  policy: EgressPolicy;
  /** Addresses and ports on this machine the engine may reach: the sandbox API. */
  allowLocal?: ReadonlyArray<{ host: string; port: number }>;
  /** The machine's own addresses, read per request (they change). Default `ownAddresses()`. */
  own?: () => ReadonlySet<string>;
  /** Tests only. */
  resolve?: ResolveAll;
  /** Tests only: connect to a checked address. */
  connect?: (address: string, port: number) => Socket;
  log?: (message: string) => void;
  /** How long a client may take to send its request head. */
  headTimeoutMs?: number;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, for HTTP_PROXY and HTTPS_PROXY. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** The response header a refusal carries, so a caller can tell it from the destination's own 403. */
export const EGRESS_REFUSED_HEADER = "X-Jarvis-Egress";

const MAX_HEAD_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;

const defaultResolve: ResolveAll = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

export class EgressDecisionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** `host` and `port` of a CONNECT authority or an http URL; null when it is not one. */
export function parseTarget(method: string, target: string): { host: string; port: number; path: string } | null {
  if (method === "CONNECT") {
    const m = /^(\[[0-9A-Fa-f:.]+\]|[^\s:[\]/]+):(\d{1,5})$/.exec(target);
    if (!m) return null;
    const port = Number(m[2]);
    return port > 0 && port < 65536 ? { host: m[1]!.replace(/^\[(.*)\]$/, "$1"), port, path: "" } : null;
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username || url.password) return null;
  const port = url.port ? Number(url.port) : 80;
  return { host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port, path: `${url.pathname}${url.search}` };
}

/**
 * Where to connect for `host:port`, or an EgressDecisionError saying why not.
 * Every address the name resolves to must be allowed (a name with one bad
 * address is refused whole, as the per-step guard does); the first is used.
 */
export async function decideDestination(
  host: string,
  port: number,
  opts: Pick<EgressProxyOptions, "policy" | "allowLocal" | "own" | "resolve">,
): Promise<string> {
  const literal = isIP(host) ? canonicalAddress(host) : null;
  if (literal && opts.allowLocal?.some((l) => canonicalAddress(l.host) === literal && l.port === port)) return literal;
  if (!literal && host.toLowerCase() === "localhost" && opts.allowLocal?.some((l) => l.port === port && canonicalAddress(l.host) === "127.0.0.1")) {
    return "127.0.0.1";
  }
  let addresses: string[];
  if (literal) {
    addresses = [literal];
  } else {
    try {
      addresses = (await (opts.resolve ?? defaultResolve)(host)).map((a) => a.address);
    } catch (e) {
      throw new EgressDecisionError(`could not resolve ${host}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, 502);
    }
    if (addresses.length === 0) throw new EgressDecisionError(`${host} resolved to no address`, 502);
  }
  const own = (opts.own ?? (() => ownAddresses()))();
  const refused = addresses.find((a) => !destinationAllowed(a, opts.policy, own));
  if (refused !== undefined) {
    const rule = opts.policy === "public-only" ? "public addresses only" : "no loopback, link-local, metadata or own addresses";
    throw new EgressDecisionError(`${host} (${refused}) is not a destination workflows may reach (${rule})`, 403);
  }
  return addresses[0]!;
}

function respond(sock: Socket, status: number, reason: string, message: string, refused: boolean): void {
  const body = `${message}\n`;
  const head =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    (refused ? `${EGRESS_REFUSED_HEADER}: refused\r\n` : "") +
    `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`;
  sock.end(head + body);
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request", 403: "Forbidden", 408: "Request Timeout", 431: "Request Header Fields Too Large",
  501: "Not Implemented", 502: "Bad Gateway",
};

/**
 * The request head to send on for an absolute-form request: origin-form
 * request line, no proxy headers, and `Connection: close`, so a client that
 * reuses its proxy connection for another host opens a new one (that request
 * would otherwise reach this host).
 */
export function rewriteHead(method: string, path: string, version: string, headerLines: string[]): string {
  const dropped = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive"]);
  const kept = headerLines.filter((line) => !dropped.has(line.slice(0, line.indexOf(":")).trim().toLowerCase()));
  return [`${method} ${path || "/"} ${version}`, ...kept, "Connection: close", "", ""].join("\r\n");
}

export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const sockets = new Set<Socket>();
  const log = opts.log ?? ((m: string) => console.warn(m));
  const recent = new Map<string, number>();
  const logRefusal = (message: string): void => {
    // Once a minute per message: piece code in a loop must not flood the log.
    const now = Date.now();
    if ((recent.get(message) ?? 0) > now - 60_000) return;
    if (recent.size > 1000) recent.clear();
    recent.set(message, now);
    log(`[egress-proxy] refused: ${message}`);
  };
  const connect = opts.connect ?? ((address: string, port: number) => netConnect({ host: address, port }));

  const handle = (client: Socket): void => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buffered = Buffer.alloc(0);
    const headTimer = setTimeout(() => respond(client, 408, STATUS_TEXT[408]!, "request head not received in time", false), opts.headTimeoutMs ?? 10_000);
    headTimer.unref?.();
    client.once("close", () => clearTimeout(headTimer));
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > MAX_HEAD_BYTES) {
          clearTimeout(headTimer);
          client.off("data", onData);
          respond(client, 431, STATUS_TEXT[431]!, "request head too large", false);
        }
        return;
      }
      clearTimeout(headTimer);
      client.off("data", onData);
      client.pause();
      const head = buffered.subarray(0, end).toString("latin1");
      const rest = buffered.subarray(end + 4);
      void forward(client, head, rest);
    };
    client.on("data", onData);
  };

  const forward = async (client: Socket, head: string, rest: Buffer): Promise<void> => {
    const [requestLine = "", ...headerLines] = head.split("\r\n");
    const parts = requestLine.split(" ");
    const [method = "", target = "", version = ""] = parts;
    if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(version)) {
      respond(client, 400, STATUS_TEXT[400]!, "not an HTTP/1.x proxy request", false);
      return;
    }
    const parsed = parseTarget(method, target);
    if (!parsed) {
      const message = method === "CONNECT"
        ? `CONNECT needs host:port, got ${JSON.stringify(target.slice(0, 200))}`
        : `this proxy forwards http:// URLs and CONNECT only, got ${JSON.stringify(target.slice(0, 200))}`;
      respond(client, method === "CONNECT" ? 400 : 501, STATUS_TEXT[method === "CONNECT" ? 400 : 501]!, message, false);
      return;
    }
    let address: string;
    try {
      address = await decideDestination(parsed.host, parsed.port, opts);
    } catch (e) {
      const err = e instanceof EgressDecisionError ? e : new EgressDecisionError(String(e), 502);
      if (err.status === 403) logRefusal(`${method} ${parsed.host}:${parsed.port}: ${err.message}`);
      respond(client, err.status, STATUS_TEXT[err.status] ?? "Error", `Jarvis egress proxy: ${err.message}`, err.status === 403);
      return;
    }
    if (client.destroyed) return;
    const upstream = connect(address, parsed.port);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    let connected = false;
    const connectTimer = setTimeout(() => upstream.destroy(new Error("connect timed out")), CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();
    upstream.on("error", (err) => {
      clearTimeout(connectTimer);
      if (!connected) respond(client, 502, STATUS_TEXT[502]!, `Jarvis egress proxy: could not connect to ${parsed.host}:${parsed.port}: ${(err as NodeJS.ErrnoException).code ?? err.message}`, false);
      else client.destroy();
    });
    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      connected = true;
      if (method === "CONNECT") {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      } else {
        upstream.write(rewriteHead(method, parsed.path, version, headerLines));
      }
      if (rest.length > 0) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.resume();
    });
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
