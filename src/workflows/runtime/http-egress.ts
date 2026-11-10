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

import { AsyncLocalStorage } from 'node:async_hooks';
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
  /**
   * True when the refusal came after the request went out: a redirect the
   * guard would not follow, a response too large. Every other refusal is
   * raised before a byte is sent, and a tracked send refused so is recorded
   * as not sent (#1153); one refused after sending stays uncertain.
   */
  readonly afterSend: boolean;
  constructor(message: string, options: { afterSend?: boolean } = {}) {
    super(message);
    this.afterSend = options.afterSend === true;
  }
}

function refusal(host: string, address: string, policy: EgressPolicy, label = 'HTTP request'): EgressRefusedError {
  const allowed = policy === 'public-only' ? 'public addresses' : 'public and private-network addresses';
  return new EgressRefusedError(`${label} to ${host} refused: it resolves to ${address}, and this Jarvis's workflow steps reach only ${allowed} (never this machine, loopback, link-local or cloud metadata)`);
}

/**
 * A response past `MAX_RESPONSE_BYTES` (#1153). A refusal like any other the
 * guard makes, so every place that already fails the step on a refusal (the
 * HTTP and GraphQL pieces, never retried or continued past, and the engine's
 * file download, which otherwise turns an error into an empty file) fails it
 * on this too.
 */
export class ResponseTooLargeError extends EgressRefusedError {
  /**
   * This one always comes after the request went out: a caller that records
   * refusals as "not sent" must not record this one so, or a retry would send
   * a non-read request twice.
   */
  constructor(message: string) {
    super(message, { afterSend: true });
  }
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

/**
 * A connection that is not HTTP (#961): the core SMTP piece's mail server, the
 * core SFTP piece's SFTP, FTP or FTPS server. Their clients (nodemailer, ssh2,
 * basic-ftp) take no `lookup`, so the host is resolved here once, every
 * address it resolves to is checked like an HTTP hop's, and the caller
 * connects to the returned address: a literal, never the name again, so
 * nothing can resolve it a second time. A TLS client passes the name as its
 * `servername`, so the certificate is still checked against the name.
 */
export function resolveGuardedAddress(hostname: string, policy: EgressPolicy, options: {
  /** What is connecting, for the refusal message: "SMTP connection", "SFTP connection". */
  label: string;
  resolve?: LookupImpl;
  allowAddress?: (address: string) => boolean;
}): Promise<string> {
  const allowed = options.allowAddress ?? ((address: string) => destinationAllowed(address, policy));
  const host = String(hostname ?? '').trim();
  const literal = host.replace(/^\[(.*)\]$/u, '$1');
  if (host === '') return Promise.reject(new EgressRefusedError(`${options.label} refused: no host`));
  if (isIP(literal) !== 0) {
    if (!allowed(literal)) return Promise.reject(refusal(host, literal, policy, options.label));
    return Promise.resolve(literal);
  }
  const resolveImpl = options.resolve ?? (dnsLookup as unknown as LookupImpl);
  return new Promise((done, fail) => {
    resolveImpl(host, { all: true }, (error, addresses) => {
      if (error) return fail(error);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) return fail(new EgressRefusedError(`${options.label} to ${host} refused: it resolves to no address`));
      const outside = list.find((entry) => !allowed(entry.address));
      if (outside) return fail(refusal(host, outside.address, policy, options.label));
      // IPv4 first when the name has both: an engine with no IPv6 route would
      // otherwise fail where the client's own lookup (which prefers IPv4 on
      // most systems) would have connected. Every address was checked above.
      done((list.find((entry) => isIP(entry.address) === 4) ?? list[0]!).address);
    });
  });
}

/** follow-redirects' default (21), which axios applies when a request sets none; a request may ask for fewer. */
export const MAX_REDIRECTS = 21;

/**
 * The most a workflow HTTP request (the HTTP and GraphQL steps, and the
 * engine's file download) reads of a response (#1153). Upstream reads without
 * limit, so one response could fill the engine's memory, and the engine
 * cannot carry one past this anyway: it fails a run whose step data passes
 * `AP_MAX_FLOW_RUN_LOG_SIZE_MB` (10 MiB by default, which Jarvis does not
 * change) less its 256 KiB error offset (`helper/logging-utils.ts`), and a
 * binary response is stored as base64, 4/3 its size. So
 * (10 MiB - 256 KiB) * 3/4, and a step fails naming this cap instead of the
 * run failing on "Flow run data size exceeded" after the whole body was read.
 * `http-egress.test.ts` pins the derivation. A request may ask for less, never more.
 */
export const MAX_RESPONSE_BYTES = ((10 * 1024 * 1024 - 256 * 1024) * 3) / 4;

/** The engine env var the daemon sets to its flow budget, in milliseconds (#1153). */
export const REQUEST_TIMEOUT_ENV = 'JARVIS_ENGINE_REQUEST_TIMEOUT_MS';

/**
 * The flow budget's default, 600 s (`DEFAULT_TIMEOUT_S` in
 * `runner/engine-runtime/operation-builder.ts`): an engine that was told
 * nothing caps a request at it.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/**
 * The longest a workflow HTTP request (the HTTP and GraphQL steps, the
 * engine's file download) may take, start to last byte (#1153). The daemon
 * stops waiting for a flow after its budget and kills the engine, losing the
 * run, so no request may outlast that budget: past it the step fails naming
 * the cap instead. A step's own shorter timeout applies as a wall clock too.
 * axios's `timeout` alone is not one: on Node's transport it is an idle timer
 * on the socket, and a server sending a byte at a time keeps it from firing
 * (measured: a 4 s response sent in 500 ms drips completed under `timeout: 1000`).
 */
export function requestTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[REQUEST_TIMEOUT_ENV]);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
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

/**
 * The form a host takes in a flow's read list (#1153) and in the checks
 * against it: what WHATWG URL parsing gives as `hostname` (lower case,
 * punycode), without IPv6 brackets or a trailing dot. Null for anything that
 * is not a bare host: a port, a path, userinfo, a wildcard, an empty string.
 */
export function readHostKey(host: unknown): string | null {
  if (typeof host !== 'string') return null;
  const trimmed = host.trim();
  if (trimmed === '' || /[\s/?#@*\\]/u.test(trimmed)) return null;
  let parsed: URL;
  try { parsed = new URL(`http://${trimmed}/`); } catch { return null; }
  if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/') return null;
  const key = parsed.hostname.replace(/^\[(.*)\]$/u, '$1').replace(/\.$/u, '');
  return key === '' ? null : key;
}

/**
 * The hosts an HTTP read that ran without asking may reach (#1153). The
 * daemon lets a GET or HEAD run without a card only when its URL's host is on
 * the flow's read list, and hands that list back with the authorization;
 * the piece runs inside `withReadHosts`, so every connection the request
 * makes, the first hop and each redirect, must go to a listed host. Without
 * it, a listed host's open redirect (`/url?q=https://elsewhere/?data=...`)
 * would carry the data on to a host nobody approved.
 */
const READ_HOST_SCOPE_KEY = Symbol.for('jarvis.http-egress.read-host-scope');
/**
 * One store per process, whichever copy of this module asks: the engine
 * bundle (which sets it, in `piece-effect-guard.ts`) and each piece bundle
 * (whose client reads it) compile in their own copy of this file, and a
 * module-level instance would give each copy its own empty store (found in
 * review: the hold was inert in a built piece).
 */
const readHostScope: AsyncLocalStorage<ReadonlySet<string>> = ((globalThis as Record<symbol, unknown>)[READ_HOST_SCOPE_KEY] ??=
  new AsyncLocalStorage<ReadonlySet<string>>()) as AsyncLocalStorage<ReadonlySet<string>>;

/** Run `fn` with its HTTP reads held to `hosts` (see `readHostScope`). */
export function withReadHosts<T>(hosts: readonly string[], fn: () => T): T {
  const keys = new Set<string>();
  for (const h of hosts) { const k = readHostKey(h); if (k) keys.add(k); }
  return readHostScope.run(keys, fn);
}

function assertReadHostListed(hostname: string, hosts: ReadonlySet<string> | undefined, hop: string): void {
  if (!hosts) return;
  const key = readHostKey(hostname.replace(/^\[(.*)\]$/u, '$1').includes(':') ? `[${hostname.replace(/^\[(.*)\]$/u, '$1')}]` : hostname);
  if (key === null || !hosts.has(key)) {
    throw new EgressRefusedError(`HTTP request refused: ${hop} goes to ${hostname || '(no host)'}, which is not on this flow's read list; a request that ran without asking reaches listed hosts only`);
  }
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
  // Taken when the instance is built, inside the piece's run (`withReadHosts`).
  const readHosts = readHostScope.getStore();
  const instance = axios.create({
    // Only Node's http transport honours `lookup`; the fetch adapter would resolve on its own.
    adapter: 'http',
    lookup,
    // Never an env proxy: the proxy, not the guard, would then pick the address.
    proxy: false,
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    beforeRedirect: (next: { hostname?: string; host?: string; protocol?: string; port?: string | number }, _response: unknown) => {
      // A redirect answers a request that was sent: whatever is refused from
      // here on (this hop's checks, or its lookup) comes after sending.
      redirected = true;
      const host = String(next.hostname ?? next.host ?? '');
      assertHostAllowed(host, policy, allowed);
      assertReadHostListed(host, readHosts, 'a redirect');
      if (!options.read && redirectOrigin(next) !== firstOrigin) {
        throw new EgressRefusedError(`HTTP request redirected to another origin (${host}); only a GET or HEAD follows a redirect off the reviewed origin`);
      }
    },
  });
  let firstOrigin = '';
  let redirected = false;
  const cap = options.timeoutMs !== undefined ? Math.min(options.timeoutMs, requestTimeoutMs()) : requestTimeoutMs();
  let wall: AbortSignal | null = null;
  let wallMs = cap;
  instance.interceptors.request.use((config: Record<string, unknown>) => {
    const target = new URL(String(config.url ?? ''), typeof config.baseURL === 'string' ? config.baseURL : undefined);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new EgressRefusedError(`HTTP request refused: ${target.protocol} is not http or https`);
    assertHostAllowed(target.hostname, policy, allowed);
    assertReadHostListed(target.hostname, readHosts, 'the request');
    // A Host header naming another host would reach that virtual host on the
    // listed host's address (a shared front end routes by it), so a read held
    // to the list may not carry one.
    if (readHosts) {
      const headers = (config.headers ?? {}) as Record<string, unknown>;
      const named = Object.keys(typeof (headers as { toJSON?: unknown }).toJSON === 'function'
        ? (headers as { toJSON(): Record<string, unknown> }).toJSON() : headers).filter((k) => k.toLowerCase() === 'host');
      if (named.length > 0) throw new EgressRefusedError('HTTP request refused: a request that ran without asking may not set its own Host header');
    }
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
    const asked = typeof config.maxContentLength === 'number' ? config.maxContentLength : -1;
    config.maxContentLength = asked >= 0 && asked < MAX_RESPONSE_BYTES ? asked : MAX_RESPONSE_BYTES;
    // A stream is handed over unread, so the size cap would not apply to it.
    if (config.responseType === 'stream') throw new EgressRefusedError('HTTP request refused: a streamed response would not be held to the size cap');
    // follow-redirects' own default, which axios uses when given none; never more.
    if (typeof config.maxRedirects !== 'number' || config.maxRedirects > MAX_REDIRECTS) config.maxRedirects = MAX_REDIRECTS;
    // A wall clock over the whole exchange, redirects and body included (#1153).
    const askedMs = typeof config.timeout === 'number' && config.timeout > 0 ? config.timeout : Infinity;
    wallMs = Math.min(askedMs, cap);
    const timer = AbortSignal.timeout(wallMs);
    wall = timer;
    config.signal = config.signal ? AbortSignal.any([config.signal as AbortSignal, timer]) : timer;
    config.timeout = wallMs;
    return config;
  });
  // A refusal raised inside the transport (the lookup, a redirect) reaches
  // axios as an AxiosError, which the piece's HTTP client turns into a bare
  // "status 500". Hand it back as itself, so the step fails naming the rule.
  instance.interceptors.response.use(undefined, (error: unknown) => {
    const refused = egressRefusalIn(error);
    if (refused) throw redirected && !refused.afterSend ? new EgressRefusedError(refused.message, { afterSend: true }) : refused;
    if (wall?.aborted) {
      // Whatever axios made of the abort ("canceled"): the step fails naming the cap. It may have been sent.
      throw new Error(`HTTP request did not finish within ${Math.round(wallMs / 1000)} seconds, the most a workflow request may take; it may have reached the server`);
    }
    // axios's own wording for a body past maxContentLength.
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && /^maxContentLength size of \d+ exceeded$/u.test(message)) {
      throw new ResponseTooLargeError(`HTTP response refused: it is larger than ${MAX_RESPONSE_BYTES} bytes, the most a workflow step can carry (${message})`);
    }
    throw error;
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
    // Another bundle's copy of this module: same code, another class. Its
    // `afterSend` is carried over, so a refusal after sending stays one.
    if ((current as { code?: unknown }).code === REFUSED_CODE) {
      return new EgressRefusedError((current as Error).message, { afterSend: (current as { afterSend?: unknown }).afterSend === true });
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * True when the error is a refusal the guard raised before the request went
 * out (#1153): nothing reached the server, so a tracked send is recorded as
 * not sent rather than as uncertain. False for anything else, including a
 * refusal after sending and every transport error, which stay uncertain.
 */
export function refusedBeforeSend(error: unknown): boolean {
  const refused = egressRefusalIn(error);
  return refused !== null && !refused.afterSend;
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
  options: Omit<GuardOptions, 'read'> & {
    /**
     * The flow's read list (#1153). A file field is fetched while its step's
     * props are resolved, before Authority is asked, so with a list the
     * download, and each redirect it follows, reaches listed hosts only.
     */
    readHosts?: readonly string[];
  } = {}): Promise<{ data: Buffer; headers: Record<string, unknown> }> {
  const { readHosts, ...guard } = options;
  const download = async () => {
    const client = egressGuardedAxios(axios, policy, { ...guard, read: true }) as unknown as {
      request(config: Record<string, unknown>): Promise<{ data: ArrayBuffer | Buffer; headers: Record<string, unknown> }>;
    };
    const response = await client.request({ method: 'GET', url, responseType: 'arraybuffer' });
    return { data: Buffer.from(response.data as ArrayBuffer), headers: response.headers };
  };
  if (!readHosts) return download();
  let host: string;
  // Not a URL: nothing to fetch, and not a refusal (the processor gives no file, as upstream).
  try { host = new URL(url).hostname; } catch { throw new Error('File download failed: not a URL'); }
  const key = readHostKey(host.replace(/^\[(.*)\]$/u, '$1').includes(':') ? `[${host.replace(/^\[(.*)\]$/u, '$1')}]` : host);
  const listed = new Set(readHosts.map((h) => readHostKey(h)).filter((h): h is string => h !== null));
  if (key === null || !listed.has(key)) {
    throw new EgressRefusedError(`File download refused: ${host || url} is not on this workflow's read list. A file field is fetched before its step is approved, so it may only come from a listed host; add ${host || 'the host'} under the workflow's permissions ("Hosts it may read without asking") if it should`);
  }
  return withReadHosts(readHosts, download);
}
