/**
 * Where a workflow's HTTP request step may connect (#961).
 *
 * THE DECISION. A hosted Jarvis runs on someone else's network, so its HTTP
 * step reaches only public addresses. A self-hosted Jarvis runs on its owner's
 * network, and reaching that network (a NAS, Home Assistant, an internal API)
 * is much of the point, so it also reaches private ranges. Neither ever
 * reaches:
 *   - loopback (127.0.0.0/8, ::1): the daemon, its sandbox API and anything
 *     else listening on the machine Jarvis runs on;
 *   - link-local (169.254.0.0/16, fe80::/10), which holds the cloud metadata
 *     services, plus the metadata addresses that sit inside private ranges
 *     (fd00:ec2::254, 100.100.100.200)
 *     and Azure's WireServer (168.63.129.16), which sits in public space;
 *   - unspecified, multicast, broadcast, documentation, benchmarking,
 *     reserved and protocol-assignment ranges, and the IPv6 transition
 *     prefixes (6to4, Teredo, NAT64) that can carry a private IPv4 address.
 *     NAT64 (64:ff9b::/96) is refused whole, so an IPv6-only host behind
 *     DNS64 cannot reach IPv4 destinations through its HTTP step.
 * Nor any address of the machine Jarvis runs on (its LAN address, a Docker
 * bridge, a VM's own public address): a service bound to 0.0.0.0 answers
 * there as it does on loopback.
 * "Hosted" is `isHostedInstall` (src/daemon/usejarvis-ai.ts), which leans
 * toward hosted when its two signals disagree. The daemon passes the answer to
 * the engine in `JARVIS_ENGINE_EGRESS`; an engine that was given nothing
 * applies the hosted rule.
 *
 * RESOLVE, THEN CONNECT. A name is resolved once, every address it resolves to
 * is checked, and the connection goes to the address that was checked: the
 * check is the request's own `lookup` (an axios `lookup`, which axios hands to
 * `http.request`). There is no second resolution for a rebinding name to
 * answer differently. Measured, because the obvious alternatives do not work
 * here: Bun 1.3.8 ignores a patched `dns.lookup`, a patched
 * `net.Socket.prototype.connect` and an `http.Agent` `lookup` for
 * `http.request` and `fetch` alike (the upstream engine's STRICT mode relies on
 * the first two), while a per-request `lookup` is honoured by 1.3.8 and 1.4.2.
 * An IP literal is never looked up, so it is checked on its own, and so is
 * every redirect target before it is followed.
 *
 * Imported by the vendored HTTP piece's bundle (`build-pieces.ts`) and by the
 * engine bundle, for its file-property download (`PATCHED_VENDOR_SOURCES` in
 * `runner/engine-runtime/build.ts`, so an edit here rebuilds the engine).
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

export type EgressPolicy = 'public-only' | 'private-allowed';

/** The engine env var the daemon sets: `private-allowed` on a self-hosted install. */
export const EGRESS_POLICY_ENV = 'JARVIS_ENGINE_EGRESS';

/** Anything but an explicit `private-allowed` is the hosted rule. */
export function egressPolicyFromEnv(env: Record<string, string | undefined> = process.env): EgressPolicy {
  return env[EGRESS_POLICY_ENV] === 'private-allowed' ? 'private-allowed' : 'public-only';
}

type AddressClass = 'public' | 'private' | 'blocked';

/** IPv4 ranges by first address and prefix length. Order matters: the first match wins. */
const V4_RANGES: ReadonlyArray<readonly [string, number, AddressClass]> = [
  ['100.100.100.200', 32, 'blocked'], // Alibaba Cloud metadata, inside the CGNAT range below
  ['168.63.129.16', 32, 'blocked'],   // Azure WireServer: host agent and DNS, in public space
  ['0.0.0.0', 8, 'blocked'],          // "this network", unspecified
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'private'],      // carrier-grade NAT, and Tailscale's tailnet
  ['127.0.0.0', 8, 'blocked'],        // loopback
  ['169.254.0.0', 16, 'blocked'],     // link-local: the AWS, GCP and Azure metadata services
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'blocked'],       // IETF protocol assignments (and Oracle Cloud metadata)
  ['192.0.2.0', 24, 'blocked'],       // documentation
  ['192.88.99.0', 24, 'blocked'],     // 6to4 relay anycast
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'blocked'],      // benchmarking
  ['198.51.100.0', 24, 'blocked'],    // documentation
  ['203.0.113.0', 24, 'blocked'],     // documentation
  ['224.0.0.0', 4, 'blocked'],        // multicast
  ['240.0.0.0', 4, 'blocked'],        // reserved, and the limited broadcast address
];

/** IPv6 ranges, first match wins. Outside every range listed, an address is blocked. */
const V6_RANGES: ReadonlyArray<readonly [string, number, AddressClass]> = [
  ['fd00:ec2::254', 128, 'blocked'],  // AWS metadata over IPv6, inside the ULA range below
  ['2001::', 23, 'blocked'],          // IETF protocol assignments, Teredo among them
  ['2001:db8::', 32, 'blocked'],      // documentation
  ['2002::', 16, 'blocked'],          // 6to4: carries an IPv4 address
  ['3fff::', 20, 'blocked'],          // documentation
  ['2000::', 3, 'public'],            // global unicast
  ['fc00::', 7, 'private'],           // unique local
];

function v4Bytes(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : NaN));
  return bytes.every((byte) => Number.isInteger(byte) && byte <= 255) ? bytes : null;
}

/** Eight 16-bit words, or null. Accepts `::` and a dotted IPv4 tail; refuses a zone id. */
function v6Words(text: string): number[] | null {
  if (text.includes('%')) return null;
  let head = text;
  const tail: number[] = [];
  const lastColon = head.lastIndexOf(':');
  if (head.slice(lastColon + 1).includes('.')) {
    const v4 = v4Bytes(head.slice(lastColon + 1));
    if (!v4) return null;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    head = head.slice(0, lastColon + 1);
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const words = part.split(':').map((word) => (/^[0-9a-f]{1,4}$/iu.test(word) ? parseInt(word, 16) : NaN));
    return words.every((word) => !Number.isNaN(word)) ? words : null;
  };
  const left = parse(halves[0]!);
  const right = halves.length === 2 ? parse(halves[1]!) : [];
  if (!left || !right) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 1) return known === 8 ? [...left, ...tail] : null;
  if (known > 7) return null;
  return [...left, ...new Array<number>(8 - known).fill(0), ...right, ...tail];
}

function inRange(bits: number[], base: number[], prefix: number, width: number): boolean {
  for (let i = 0; i < prefix; i++) {
    const word = Math.floor(i / width), shift = width - 1 - (i % width);
    if (((bits[word]! >> shift) & 1) !== ((base[word]! >> shift) & 1)) return false;
  }
  return true;
}

function classifyV4(bytes: number[]): AddressClass {
  for (const [base, prefix, kind] of V4_RANGES) if (inRange(bytes, v4Bytes(base)!, prefix, 8)) return kind;
  return 'public';
}

/**
 * The class of one IP address, or `blocked` for anything that does not parse.
 * An IPv4-mapped IPv6 address is the IPv4 address it carries.
 */
export function classifyAddress(address: string): AddressClass {
  const literal = address.replace(/^\[(.*)\]$/u, '$1');
  const v4 = v4Bytes(literal);
  if (v4) return classifyV4(v4);
  const words = v6Words(literal);
  if (!words) return 'blocked';
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return classifyV4([words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff]);
  }
  for (const [base, prefix, kind] of V6_RANGES) if (inRange(words, v6Words(base)!, prefix, 16)) return kind;
  return 'blocked';
}

export function addressAllowed(address: string, policy: EgressPolicy): boolean {
  const kind = classifyAddress(address);
  return kind === 'public' || (kind === 'private' && policy === 'private-allowed');
}

/** One spelling per address: dotted IPv4 (a mapped IPv6 address is its IPv4), or eight hex words. */
export function canonicalAddress(address: string): string | null {
  const literal = address.replace(/^\[(.*)\]$/u, '$1');
  const v4 = v4Bytes(literal);
  if (v4) return v4.join('.');
  const words = v6Words(literal);
  if (!words) return null;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join('.');
  }
  return words.map((word) => word.toString(16)).join(':');
}

/** The addresses of this machine's own interfaces, read when asked (they change). */
export function interfaceAddresses(): Set<string> {
  const out = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const canonical = canonicalAddress(entry.address);
      if (canonical) out.add(canonical);
    }
  }
  return out;
}

/**
 * The policy, plus: never this machine itself. A service bound to 0.0.0.0 on
 * the host answers on every interface address -- the LAN address, a Docker
 * bridge, a hosted VM's own public address -- not only on loopback.
 */
export function destinationAllowed(address: string, policy: EgressPolicy, own: ReadonlySet<string> = interfaceAddresses()): boolean {
  const canonical = canonicalAddress(address);
  return canonical !== null && addressAllowed(address, policy) && !own.has(canonical);
}

/** Why a request was refused. Never retried by the piece: its message names the rule. */
const REFUSED_CODE = 'ERR_EGRESS_REFUSED';
export class EgressRefusedError extends Error {
  readonly code = REFUSED_CODE;
}

function refusal(host: string, address: string, policy: EgressPolicy): EgressRefusedError {
  const allowed = policy === 'public-only' ? 'public addresses' : 'public and private-network addresses';
  return new EgressRefusedError(`HTTP request to ${host} refused: it resolves to ${address}, and this Jarvis's HTTP steps reach only ${allowed} (never this machine, loopback, link-local or cloud metadata)`);
}

/** Refuse an IP-literal host outside the policy. A name is checked by `guardedLookup` instead. */
export function assertHostAllowed(hostname: string, policy: EgressPolicy,
  allowed: (address: string) => boolean = (address) => destinationAllowed(address, policy)): void {
  const literal = hostname.replace(/^\[(.*)\]$/u, '$1');
  if (isIP(literal) !== 0 && !allowed(literal)) throw refusal(hostname, literal, policy);
}

type LookupCallback = (error: Error | null, address?: string | LookupAddress[], family?: number) => void;
type LookupImpl = (hostname: string, options: { all: true; family?: number; hints?: number }, callback: (error: Error | null, addresses: LookupAddress[]) => void) => void;

/**
 * A `lookup` for `http.request` (through axios) that resolves every address,
 * refuses the name if ANY of them is outside the policy, and hands the
 * connection exactly the addresses it checked.
 */
export function guardedLookup(policy: EgressPolicy, resolve: LookupImpl = dnsLookup as unknown as LookupImpl,
  allowed: (address: string) => boolean = (address) => destinationAllowed(address, policy)) {
  return (hostname: string, options: unknown, callback?: LookupCallback): void => {
    const done = (typeof options === 'function' ? options : callback) as LookupCallback;
    const opts = typeof options === 'object' && options !== null ? options as { all?: boolean; family?: number; hints?: number } : {};
    resolve(hostname, { family: opts.family, hints: opts.hints, all: true }, (error, addresses) => {
      if (error) return done(error);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) return done(new EgressRefusedError(`HTTP request to ${hostname} refused: it resolves to no address`));
      const outside = list.find((entry) => !allowed(entry.address));
      if (outside) return done(refusal(hostname, outside.address, policy));
      if (opts.all) return done(null, list);
      return done(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** The subset of axios this needs; the piece passes its own bundled copy. */
interface AxiosLike {
  create(config: Record<string, unknown>): {
    interceptors: {
      request: { use(onFulfilled: (config: any) => any): unknown };
      response: { use(onFulfilled: undefined, onRejected: (error: any) => any): unknown };
    };
  };
}

export interface GuardOptions {
  /** True for a GET or HEAD. A request that is not a read never follows a redirect to another origin. */
  read: boolean;
  /** Injectable for tests. */
  resolve?: LookupImpl;
  /** Test seam: replaces the policy's address check. Production never passes it. */
  allowAddress?: (address: string) => boolean;
  /** Request timeout in ms; tests set one so a regressed guard fails fast instead of hanging. */
  timeoutMs?: number;
}

/**
 * An axios instance whose every connection, first hop and redirect alike,
 * passes the egress policy. Built per request, so nothing a flow does can
 * leave state on it for the next one.
 */
export function egressGuardedAxios<A extends AxiosLike>(axios: A, policy: EgressPolicy, options: GuardOptions): ReturnType<A['create']> {
  const allowed = options.allowAddress ?? ((address: string) => destinationAllowed(address, policy));
  const lookup = guardedLookup(policy, options.resolve, allowed);
  const instance = axios.create({
    // Only Node's http transport honours `lookup`; the fetch adapter would resolve on its own.
    adapter: 'http',
    lookup,
    // Never an env proxy: the proxy, not the guard, would then pick the address.
    proxy: false,
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    beforeRedirect: (next: { hostname?: string; host?: string; protocol?: string; port?: string | number }, _response: unknown) => {
      const host = String(next.hostname ?? next.host ?? '');
      assertHostAllowed(host, policy, allowed);
      if (!options.read && redirectOrigin(next) !== firstOrigin) {
        throw new EgressRefusedError(`HTTP request redirected to another origin (${host}); only a GET or HEAD follows a redirect off the reviewed origin`);
      }
    },
  });
  let firstOrigin = '';
  instance.interceptors.request.use((config: Record<string, unknown>) => {
    const target = new URL(String(config.url ?? ''), typeof config.baseURL === 'string' ? config.baseURL : undefined);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new EgressRefusedError(`HTTP request refused: ${target.protocol} is not http or https`);
    assertHostAllowed(target.hostname, policy, allowed);
    firstOrigin = `${target.protocol}//${target.hostname.replace(/^\[(.*)\]$/u, '$1').toLowerCase()}:${target.port || (target.protocol === 'https:' ? '443' : '80')}`;
    // Whatever the request config carries, the connection goes through this
    // instance's checked lookup: no socket path or transport of its own, and a
    // fresh agent that keeps no socket alive. A pooled keep-alive socket is
    // reused WITHOUT a lookup, so a socket another request left open (to a
    // name that resolved inward, or under another policy) would carry this
    // one past the check: measured on Bun 1.4.2, where a second request to a
    // host:port answered from the first one's socket and never asked.
    delete config.socketPath; delete config.transport;
    config.httpAgent = new HttpAgent({ keepAlive: false, lookup } as ConstructorParameters<typeof HttpAgent>[0]);
    config.httpsAgent = new HttpsAgent({ keepAlive: false, lookup } as ConstructorParameters<typeof HttpsAgent>[0]);
    config.proxy = false; config.lookup = lookup; config.adapter = 'http';
    return config;
  });
  // A refusal raised inside the transport (the lookup, a redirect) reaches
  // axios as an AxiosError, which the piece's HTTP client turns into a bare
  // "status 500". Hand it back as itself, so the step fails naming the rule.
  instance.interceptors.response.use(undefined, (error: unknown) => {
    throw egressRefusalIn(error) ?? error;
  });
  return instance as ReturnType<A['create']>;
}

/**
 * The refusal inside an error, whichever wrappers it arrived in: axios wraps
 * a transport error once, and follow-redirects wraps a redirect's once more.
 */
export function egressRefusalIn(error: unknown): EgressRefusedError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    if (current instanceof EgressRefusedError) return current;
    if ((current as { code?: unknown }).code === REFUSED_CODE) return new EgressRefusedError((current as Error).message);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function redirectOrigin(next: { hostname?: string; host?: string; protocol?: string; port?: string | number }): string {
  const protocol = String(next.protocol ?? '');
  const host = String(next.hostname ?? next.host ?? '').replace(/^\[(.*)\]$/u, '$1').toLowerCase();
  const port = next.port !== undefined && next.port !== '' && next.port !== null ? String(next.port) : protocol === 'https:' ? '443' : '80';
  return `${protocol}//${host}:${port}`;
}

/**
 * The engine's file-property download (`processors/file.ts`), through the same
 * guard (#961 security review). Upstream fetched any URL a flow put in a file
 * field with a plain `fetch`, while the step's props were still being resolved:
 * before Authority was asked and outside this policy, so an HTTP step's
 * form-data file field could read a metadata or loopback URL and send it on.
 * A file URL is now resolved, checked and connected to like any request; the
 * redirects it follows are checked one by one.
 */
export async function guardedFileDownload<A extends AxiosLike>(axios: A, url: string, policy: EgressPolicy,
  options: Omit<GuardOptions, 'read'> = {}): Promise<{ data: Buffer; headers: Record<string, unknown> }> {
  const client = egressGuardedAxios(axios, policy, { ...options, read: true }) as unknown as {
    request(config: Record<string, unknown>): Promise<{ data: ArrayBuffer | Buffer; headers: Record<string, unknown> }>;
  };
  const response = await client.request({ method: 'GET', url, responseType: 'arraybuffer' });
  return { data: Buffer.from(response.data as ArrayBuffer), headers: response.headers };
}
