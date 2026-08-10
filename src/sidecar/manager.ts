/**
 * Sidecar Manager
 *
 * Brain-side service that manages sidecar enrollment, authentication,
 * and connection tracking. Handles ES256 key pair lifecycle and JWT signing.
 */

import { generateKeyPair, exportJWK, exportPKCS8, exportSPKI, importPKCS8, importSPKI, SignJWT, jwtVerify, createRemoteJWKSet, type JWK } from 'jose';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ServerWebSocket } from 'bun';
import type { Service, ServiceStatus } from '../daemon/services.ts';
import { getDb, generateId } from '../vault/schema.ts';
import type {
  SidecarRecord,
  SidecarInfo,
  SidecarTokenClaims,
  ConnectedSidecar,
  SidecarCapability,
  UnavailableCapability,
} from './types.ts';
import type { RPCRequest, RPCTimeouts, SidecarEvent, RPCResultPayload, RPCErrorPayload, RPCProgressPayload } from './protocol.ts';
import { DEFAULT_RPC_TIMEOUTS } from './protocol.ts';
import { EventScheduler, type DroppedEventsStats } from './scheduler.ts';
import { RPCTracker } from './rpc.ts';
import { BinarySpool, type BinarySpoolStats } from './binary-spool.ts';
import { SidecarConnection } from './connection.ts';
import { classifySidecarVersion, SIDECAR_MIN_VERSION, SIDECAR_RECOMMENDED_VERSION } from './compat.ts';
import { chmodWithWarning, secureDirectory, secureWriteFile } from '../util/fs-secure.ts';
import { computeAnonId } from '../telemetry/anon-id.ts';
import { loadOrGenerateSidecarKeys, enrollDevice, buildEnrollmentUrls, isLocalhostBrainUrl } from './enrollment.ts';

export { buildEnrollmentUrls, isLocalhostBrainUrl } from './enrollment.ts';

const ALG = 'ES256';
const KEY_DIR_NAME = 'sidecar-keys';
const PRIVATE_KEY_FILE = 'private.pem';
const PUBLIC_KEY_FILE = 'public.pem';

// Short-lived access tokens. The enrollment JWT is a long-lived REFRESH-style
// credential that never leaves the sidecar except as an Authorization: Bearer
// header to /sidecar/connect and the token-mint endpoint. Everything on the
// data plane (panel /api fetches, the /ws control socket) authenticates with
// one of these instead: minted on demand from the enrollment JWT, signed with
// the same ES256 key, scoped by audience, and verified statelessly (signature +
// exp + aud, no DB hit) so a leak is bounded to the TTL rather than forever.
const ACCESS_TOKEN_AUDIENCE = 'brain-api';
const ACCESS_TOKEN_TTL_SECONDS = 600; // 10 minutes

/**
 * Accept only strings shaped like IANA zone names ("Area/City", up to three
 * segments, "UTC"), max 64 chars. Mirrors the Go sidecar's ianaNameRe.
 */
const IANA_TZ_RE = /^[A-Za-z_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/;

export function sanitizeIanaTimezone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  return IANA_TZ_RE.test(trimmed) ? trimmed : undefined;
}

/** Send handle for a sidecar's dedicated realtime-audio pipe. */
export interface SidecarAudioChannel {
  /** Send a raw PCM playback frame (s16/mono/24 kHz) to the sidecar. */
  sendPCM(buf: Buffer): void;
  /** Tell the sidecar to flush playback immediately (barge-in). */
  sendFlush(): void;
}

export class SidecarManager implements Service {
  readonly name = 'sidecar-manager';

  private privateKey: CryptoKey | null = null;
  private publicKey: CryptoKey | null = null;
  private publicJwk: JWK | null = null;
  private keyId: string = '';
  private dataDir: string;
  private brainUrl: string = '';
  private _status: ServiceStatus = 'stopped';

  /** Runtime map of connected sidecars (not persisted) */
  private connected = new Map<string, ConnectedSidecar>();

  /** Protocol infrastructure */
  private scheduler: EventScheduler;
  private rpcTracker: RPCTracker;
  private binarySpool: BinarySpool;
  private sidecarConnections = new Map<string, SidecarConnection>();
  private revocationSweepTimer: ReturnType<typeof setInterval> | null = null;
  private progressListeners = new Set<(sidecarId: string, rpcId: string, progress: number, message?: string) => void>();
  private eventListeners = new Set<(sidecarId: string, event: SidecarEvent) => void>();
  // Two parallel notify APIs:
  //   • onConnect(id) — main's lightweight handler (just an id, fires on
  //     each WS reconnect for routing-table refreshes)
  //   • onSidecarConnected(sidecar) / onSidecarDisconnected(id) — our
  //     ambient-UI pebble-spawn handler (needs the full ConnectedSidecar
  //     to read capabilities before deciding to spawn)
  private connectListeners = new Set<(sidecarId: string) => void>();
  private connectedListeners = new Set<(sidecar: ConnectedSidecar) => void>();
  private disconnectedListeners = new Set<(sidecarId: string) => void>();

  /**
   * Dedicated realtime-audio pipes, one per sidecar (the pebble's `?channel=audio`
   * connection). Kept separate from `sidecarConnections` so a 2.4 MB screenshot on
   * the control connection can't queue in front of audio frames. Binary frames on
   * this socket are raw PCM (mic in / playback out).
   */
  private audioChannels = new Map<string, ServerWebSocket<unknown>>();
  private audioFrameListeners = new Set<(sidecarId: string, frame: Buffer) => void>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.scheduler = new EventScheduler();
    this.rpcTracker = new RPCTracker();
    this.binarySpool = new BinarySpool(dataDir);
  }

  /**
   * Event-pressure counters: queue-overflow drops and disk-spool activity.
   * For dashboards/health surfaces, mirroring WorkflowEventBuffer.dropped().
   */
  getEventStats(): { dropped: DroppedEventsStats; spool: BinarySpoolStats } {
    return { dropped: this.scheduler.dropped(), spool: this.binarySpool.stats() };
  }

  /**
   * Set the brain's external URL (used in JWT claims).
   * Must be called before enrolling sidecars.
   * Example: "shiny-panda.domain.com" or "localhost:3142"
   *
   * `source` is rendered in the startup log so operators can see at a
   * glance which knob is active when something looks wrong (env var vs
   * config.yaml vs default-fallback). Pass undefined for silent setters.
   */
  setBrainUrl(url: string, source?: 'env' | 'config' | 'public_url' | 'default'): void {
    this.brainUrl = url;
    if (source) {
      const { brainWs } = buildEnrollmentUrls(url);
      const sourceLabel = source === 'env' ? 'JARVIS_PUBLIC_URL / JARVIS_BRAIN_DOMAIN env var'
        : source === 'public_url' ? 'daemon.public_url / JARVIS_PUBLIC_URL'
        : source === 'config' ? 'config.yaml daemon.brain_domain'
        : `default fallback — set daemon.public_url in config.yaml or JARVIS_PUBLIC_URL env to override`;
      console.log(`[SidecarManager] Brain URL: ${brainWs} (source: ${sourceLabel})`);
      if (isLocalhostBrainUrl(url)) {
        console.warn(
          `[SidecarManager] Brain URL points at a local host. Sidecars on other machines will NOT be able to reach this URL — only enroll local sidecars, or set daemon.public_url to a routable HTTPS origin before enrolling remote sidecars.`,
        );
      }
    }
  }

  // --------------- Service Interface ---------------

  async start(): Promise<void> {
    this._status = 'starting';
    try {
      await this.loadOrGenerateKeys();

      // CLI revocations happen in another process; sweep so they take
      // effect on live sessions within ~30s, not only at the next connect.
      this.revocationSweepTimer = setInterval(() => {
        try {
          this.sweepRevokedConnections();
        } catch (err) {
          console.error('[SidecarManager] Revocation sweep failed:', err);
        }
      }, 30_000);

      // Wire scheduler handlers
      this.scheduler.on('rpc_result', async (sidecarId, event) => {
        const payload = event.payload as RPCResultPayload | RPCErrorPayload;
        if (payload.error) {
          this.rpcTracker.fail(payload.rpc_id, new Error(`${payload.error.code}: ${payload.error.message}`));
        } else {
          // Attach binary data to result when present (e.g. capture_screen returns image in binary)
          const result = payload.result as Record<string, unknown> | undefined;
          if (event.binary && result && typeof result === 'object') {
            (result as Record<string, unknown>)._binary = event.binary;
          }
          this.rpcTracker.resolve(payload.rpc_id, result);
        }
      });

      this.scheduler.on('rpc_progress', async (sidecarId, event) => {
        const payload = event.payload as RPCProgressPayload;
        for (const listener of this.progressListeners) {
          listener(sidecarId, payload.rpc_id, payload.progress, payload.message);
        }
      });

      // Register handlers for each sidecar observer event type
      const sidecarEventTypes = ['screen_capture', 'context_changed', 'idle_detected', 'clipboard_change', 'file_change', 'process_started', 'process_stopped', 'notification', 'pebble.summon', 'pebble.palette', 'pebble.blind_toggle', 'pebble.open_answer', 'panel.bounds_changed', 'panel.closed', 'audio.session_start', 'audio.session_end', 'audio.wake_segment', 'region.captured', 'region.cancelled', 'sub_pebble.clicked', 'sub_pebble.open_full', 'pebble.realtime_start', 'pebble.realtime_stop', 'pebble.audio_frame', 'tray.set_pause', 'tray.set_mute', 'notify.action'];
      const sidecarEventHandler = async (sidecarId: string, event: SidecarEvent) => {
        for (const listener of this.eventListeners) {
          listener(sidecarId, event);
        }
      };
      for (const type of sidecarEventTypes) {
        this.scheduler.on(type, sidecarEventHandler);
      }
      // Realtime voice events bypass the 1-per-tick queue: realtime_start must
      // open the session before mic frames arrive, and audio_frame streams at
      // ~25/s (faster than the queue drains). Direct dispatch keeps them
      // real-time and in receive order.
      this.scheduler.setDirectTypes(['pebble.realtime_start', 'pebble.realtime_stop', 'pebble.audio_frame']);

      this.rpcTracker.onDetachedComplete((rpcId, result, error) => {
        if (error) {
          console.warn(`[SidecarManager] Detached RPC ${rpcId} failed:`, error.message);
        } else {
          console.log(`[SidecarManager] Detached RPC ${rpcId} completed`);
        }
      });

      this.scheduler.start();
      this.binarySpool.start();

      this._status = 'running';
      console.log('[SidecarManager] Started — keys loaded, scheduler running');
    } catch (err) {
      this._status = 'error';
      throw err;
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';

    if (this.revocationSweepTimer) {
      clearInterval(this.revocationSweepTimer);
      this.revocationSweepTimer = null;
    }

    // Stop scheduler
    this.scheduler.stop();
    this.binarySpool.stop();

    // Close all sidecar connections and fail pending RPCs. Use WS 1001 (Going
    // Away) + reason so the sidecar recognizes a planned restart and reconnects
    // promptly against the freshly-booted brain (same keys + JWT).
    for (const [id, conn] of this.sidecarConnections) {
      this.rpcTracker.failAll(id, 'manager stopping');
      conn.close(1001, 'server restarting');
    }
    this.sidecarConnections.clear();

    this.privateKey = null;
    this.publicKey = null;
    this.publicJwk = null;
    this.connected.clear();
    this._status = 'stopped';
    console.log('[SidecarManager] Stopped');
  }

  status(): ServiceStatus {
    return this._status;
  }

  // --------------- Key Management ---------------

  private get keysDir(): string {
    return path.join(this.dataDir, KEY_DIR_NAME);
  }

  private get privateKeyPath(): string {
    return path.join(this.keysDir, PRIVATE_KEY_FILE);
  }

  private get publicKeyPath(): string {
    return path.join(this.keysDir, PUBLIC_KEY_FILE);
  }

  private async loadOrGenerateKeys(): Promise<void> {
    const keys = await loadOrGenerateSidecarKeys(this.dataDir, (msg) =>
      console.log(`[SidecarManager] ${msg}`),
    );
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
    this.publicJwk = keys.publicJwk;
    this.keyId = keys.keyId;
  }

  // --------------- JWKS ---------------

  /**
   * Returns the JWKS (JSON Web Key Set) containing the brain's public key.
   * Served at GET /api/sidecars/.well-known/jwks.json
   */
  getJwks(): { keys: JWK[] } {
    if (!this.publicJwk) {
      throw new Error('SidecarManager not started');
    }
    return {
      keys: [
        {
          ...this.publicJwk,
          alg: ALG,
          use: 'sig',
          kid: this.keyId,
        },
      ],
    };
  }

  // --------------- Enrollment ---------------

  /**
   * Enroll a new sidecar. Returns the signed JWT enrollment token.
   * Delegates to the standalone enrollment module (shared with the
   * `jarvis enroll` CLI); the dashboard API keeps reject-on-duplicate.
   */
  async enrollSidecar(name: string): Promise<{ token: string; sidecar: SidecarRecord }> {
    if (!this.privateKey || !this.publicJwk) throw new Error('SidecarManager not started');
    if (!this.brainUrl) throw new Error('Brain URL not configured — call setBrainUrl() first');

    const { token, sidecar } = await enrollDevice(this.dataDir, this.brainUrl, name, {
      onExisting: 'reject',
      keys: {
        privateKey: this.privateKey,
        publicKey: this.publicKey!,
        publicJwk: this.publicJwk,
        keyId: this.keyId,
      },
    });
    console.log(`[SidecarManager] Enrolled sidecar "${sidecar.name}" (${sidecar.id})`);
    return { token, sidecar };
  }

  // --------------- Registry (DB queries) ---------------

  /** Get all enrolled sidecars with connection state */
  listSidecars(): SidecarInfo[] {
    const db = getDb();
    const records = db.query('SELECT * FROM sidecars WHERE status = ? ORDER BY enrolled_at DESC').all('enrolled') as SidecarRecord[];
    return records.map((r) => this.toSidecarInfo(r));
  }

  /** Get a single sidecar by ID */
  getSidecar(id: string): SidecarInfo | null {
    const db = getDb();
    const record = db.query('SELECT * FROM sidecars WHERE id = ?').get(id) as SidecarRecord | null;
    return record ? this.toSidecarInfo(record) : null;
  }

  /** Revoke a sidecar and remove it from the database. Disconnects if connected. */
  revokeSidecar(id: string): boolean {
    const db = getDb();
    const result = db.run('DELETE FROM sidecars WHERE id = ? AND status = ?', [id, 'enrolled']);
    if (result.changes > 0) {
      // Sever any LIVE session too - deleting the row alone only blocks the
      // next connect, and a revoked-but-connected sidecar would keep routing
      // RPCs indefinitely (stolen-device scenario).
      this.handleSidecarDisconnect(id);
      this.connected.delete(id);
      console.log(`[SidecarManager] Revoked and removed sidecar ${id}`);
      return true;
    }
    return false;
  }

  /**
   * Disconnect any live session whose enrollment row is gone. Covers
   * revocations the daemon cannot observe directly: `jarvis revoke` runs in
   * a SEPARATE process and deletes the row in the shared (WAL) DB, so the
   * daemon re-checks periodically. Runs every 30s from start(); public so
   * tests (and ops surfaces) can force a sweep.
   */
  sweepRevokedConnections(): number {
    let severed = 0;
    for (const id of [...this.sidecarConnections.keys()]) {
      if (!this.isEnrolled(id)) {
        console.log(`[SidecarManager] Severing revoked sidecar session: ${id}`);
        this.handleSidecarDisconnect(id);
        this.connected.delete(id);
        severed++;
      }
    }
    return severed;
  }

  /** Check if a sidecar ID is enrolled (not revoked) */
  isEnrolled(id: string): boolean {
    const db = getDb();
    const row = db.query('SELECT id FROM sidecars WHERE id = ? AND status = ?').get(id, 'enrolled');
    return row !== null;
  }

  /** Update last_seen_at for a sidecar */
  touchSidecar(id: string): void {
    const db = getDb();
    db.run("UPDATE sidecars SET last_seen_at = datetime('now') WHERE id = ?", [id]);
  }

  // --------------- Connection Tracking ---------------

  /** Register a connected sidecar (called after WS handshake + registration message) */
  registerConnection(sidecar: ConnectedSidecar): void {
    // The reported timezone is untrusted sidecar input headed for sensitive
    // sinks: `jarvis sidecars list --json` (read by the hosting server) and,
    // downstream, the root-owned system config the server writes. Persist it
    // only when it LOOKS like an IANA zone name; anything else becomes null.
    const timezone = sanitizeIanaTimezone(sidecar.timezone);
    this.connected.set(sidecar.id, { ...sidecar, timezone });
    // Persist connection details to DB so they're available even when offline
    const db = getDb();
    db.run(
      `UPDATE sidecars SET last_seen_at = datetime('now'), hostname = ?, os = ?, platform = ?, capabilities = ?, version = ?, timezone = COALESCE(?, timezone) WHERE id = ?`,
      [sidecar.hostname, sidecar.os, sidecar.platform, JSON.stringify(sidecar.capabilities), sidecar.version, timezone ?? null, sidecar.id],
    );
    console.log(`[SidecarManager] Sidecar connected: ${sidecar.name} (${sidecar.id})`);
    // Fire both listener flavours — main uses onConnect(id) for routing,
    // our ambient block uses onSidecarConnected(sidecar) for the pebble spawn.
    for (const listener of this.connectListeners) {
      try { listener(sidecar.id); } catch (err) {
        console.error('[SidecarManager] connect listener error:', err instanceof Error ? err.message : err);
      }
    }
    for (const listener of this.connectedListeners) {
      try {
        listener(sidecar);
      } catch (err) {
        console.warn(`[SidecarManager] connected listener threw:`, err);
      }
    }
  }

  /** Remove a connected sidecar (called on WS close) */
  removeConnection(id: string): void {
    const sc = this.connected.get(id);
    this.connected.delete(id);
    if (sc) {
      console.log(`[SidecarManager] Sidecar disconnected: ${sc.name} (${id})`);
      for (const listener of this.disconnectedListeners) {
        try {
          listener(id);
        } catch (err) {
          console.warn(`[SidecarManager] disconnected listener threw:`, err);
        }
      }
    }
  }

  /** Register a callback fired after a sidecar registers (post-handshake). */
  onSidecarConnected(listener: (sidecar: ConnectedSidecar) => void): void {
    this.connectedListeners.add(listener);
  }

  /** Register a callback fired when a sidecar disconnects. */
  onSidecarDisconnected(listener: (sidecarId: string) => void): void {
    this.disconnectedListeners.add(listener);
  }

  /** Update capabilities for a connected sidecar (called on config reload) */
  updateCapabilities(sidecarId: string, capabilities: SidecarCapability[], unavailableCapabilities: UnavailableCapability[] = []): void {
    const conn = this.connected.get(sidecarId);
    if (conn) {
      conn.capabilities = capabilities;
      conn.unavailableCapabilities = unavailableCapabilities;
    }
    const db = getDb();
    db.run('UPDATE sidecars SET capabilities = ? WHERE id = ?', [JSON.stringify(capabilities), sidecarId]);
    console.log(`[SidecarManager] Capabilities updated for ${sidecarId}: ${capabilities.join(', ')}`);
    if (unavailableCapabilities.length > 0) {
      console.log(`[SidecarManager] Unavailable: ${unavailableCapabilities.map(u => u.name).join(', ')}`);
    }
  }

  /** Get all currently connected sidecars */
  getConnectedSidecars(): ConnectedSidecar[] {
    return Array.from(this.connected.values());
  }

  /** Check if a specific sidecar is connected */
  isConnected(id: string): boolean {
    return this.connected.has(id);
  }

  // --------------- Protocol: Token Validation ---------------

  /**
   * Verify a JWT token and return claims if valid and sidecar is enrolled.
   */
  async validateToken(token: string): Promise<SidecarTokenClaims | null> {
    if (!this.publicKey) return null;

    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALG],
      });

      const claims = payload as unknown as SidecarTokenClaims;

      // A short-lived access token (aud=brain-api) must never be accepted as an
      // enrollment credential. validateToken gates /sidecar/connect and the
      // token-mint endpoint; if an access token passed here it could mint fresh
      // access tokens indefinitely, defeating its TTL. Enrollment JWTs carry no
      // audience, so reject anything bearing the access-token audience.
      if ((payload as Record<string, unknown>).aud === ACCESS_TOKEN_AUDIENCE) {
        return null;
      }

      // Check sidecar is still enrolled
      if (!claims.sid || !this.isEnrolled(claims.sid)) {
        return null;
      }

      return claims;
    } catch {
      return null;
    }
  }

  /**
   * Mint a short-lived access token for an enrolled sidecar. This is the only
   * credential that authenticates the data plane (panel /api fetches + /ws); the
   * enrollment JWT is never accepted there. Enrollment is checked here at mint
   * time, so a revoked sidecar can't obtain new tokens (and existing ones expire
   * within the TTL). Returns null if the sidecar isn't enrolled or keys aren't
   * loaded.
   */
  async issueAccessToken(sid: string): Promise<{ token: string; expiresIn: number } | null> {
    if (!this.privateKey) return null;
    if (!sid || !this.isEnrolled(sid)) return null;
    const token = await new SignJWT({ sid })
      .setProtectedHeader({ alg: ALG, kid: this.keyId })
      .setSubject(`sidecar:${sid}`)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.privateKey);
    return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  /**
   * Verify a short-lived access token. Returns { sid } if the signature,
   * audience, and expiry all check out, else null. Deliberately stateless (no
   * DB / isEnrolled lookup): the short TTL is the revocation mechanism, which
   * also keeps this cheap on every authenticated request.
   */
  async verifyAccessToken(token: string): Promise<{ sid: string } | null> {
    if (!this.publicKey) return null;
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALG],
        audience: ACCESS_TOKEN_AUDIENCE,
      });
      const sid = typeof payload.sid === 'string' ? payload.sid : '';
      if (!sid) return null;
      return { sid };
    } catch {
      return null;
    }
  }

  // --------------- Protocol: WebSocket Handlers ---------------

  /** Called when a sidecar WebSocket connects (after JWT validation) */
  handleSidecarConnect(ws: ServerWebSocket<unknown>, sidecarId: string): void {
    const connection = new SidecarConnection(
      sidecarId,
      ws,
      this.scheduler,
      () => this.handleSidecarDisconnect(sidecarId),
      this.binarySpool,
    );
    connection.startHeartbeat();
    this.sidecarConnections.set(sidecarId, connection);
    this.touchSidecar(sidecarId);
    console.log(`[SidecarManager] Sidecar WS connected: ${sidecarId}`);
  }

  /** Route inbound messages to the correct SidecarConnection */
  handleSidecarMessage(ws: ServerWebSocket<unknown>, message: string | Buffer): void {
    // Find connection by ws — we need the sidecar_id from ws.data
    const sidecarId = (ws.data as any)?.sidecar_id as string;
    if (!sidecarId) return;

    // Intercept registration messages before routing to connection
    if (typeof message === 'string') {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'register') {
          const reportedVersion = typeof parsed.version === 'string' && parsed.version ? parsed.version : 'dev';
          const verdict = classifySidecarVersion(reportedVersion);

          if (verdict === 'blocked') {
            // Hard floor: the sidecar is too old for this brain. Tell it why and
            // close the socket. We do NOT registerConnection — an incompatible
            // sidecar must not operate.
            console.warn(`[SidecarManager] Rejecting sidecar ${sidecarId}: version ${reportedVersion} < required ${SIDECAR_MIN_VERSION}`);
            try {
              ws.send(JSON.stringify({
                type: 'register_rejected',
                reason: 'incompatible',
                min: SIDECAR_MIN_VERSION,
                your_version: reportedVersion,
              }));
            } catch { /* socket may already be gone */ }
            ws.close(4001, 'sidecar version incompatible');
            return;
          }

          if (verdict === 'suggested') {
            // Compatible but below RECOMMENDED — accept and advise an update.
            try {
              ws.send(JSON.stringify({
                type: 'register_ack',
                update_suggested: true,
                recommended: SIDECAR_RECOMMENDED_VERSION,
              }));
            } catch { /* best-effort */ }
            console.log(`[SidecarManager] Sidecar ${sidecarId} v${reportedVersion} is below recommended ${SIDECAR_RECOMMENDED_VERSION} — update suggested`);
          }

          const record = this.getSidecar(sidecarId);
          this.registerConnection({
            id: sidecarId,
            name: record?.name ?? parsed.hostname ?? sidecarId,
            hostname: parsed.hostname ?? 'unknown',
            os: parsed.os ?? 'unknown',
            platform: parsed.platform ?? 'unknown',
            version: reportedVersion,
            updateStatus: verdict,
            capabilities: parsed.capabilities ?? [],
            unavailableCapabilities: parsed.unavailable_capabilities ?? [],
            timezone: typeof parsed.timezone === 'string' ? parsed.timezone : undefined,
            connectedAt: new Date(),
          });
          return;
        }
        if (parsed.type === 'capabilities_update') {
          this.updateCapabilities(sidecarId, parsed.capabilities ?? [], parsed.unavailable_capabilities ?? []);
          return;
        }
      } catch {
        // Not JSON or not a register message — fall through to connection handler
      }
    }

    const connection = this.sidecarConnections.get(sidecarId);
    if (!connection) return;

    if (message instanceof Buffer) {
      connection.handleBinary(message);
    } else {
      connection.handleMessage(message.toString());
    }
  }

  /** Called when a pong is received from a sidecar */
  handleSidecarPong(sidecarId: string): void {
    const connection = this.sidecarConnections.get(sidecarId);
    if (connection) {
      connection.handlePong();
    }
  }

  /** Called when a sidecar WebSocket disconnects */
  handleSidecarDisconnect(sidecarId: string): void {
    const conn = this.sidecarConnections.get(sidecarId);
    if (conn) {
      conn.close();
      this.sidecarConnections.delete(sidecarId);
    }
    this.scheduler.removeSidecar(sidecarId);
    this.rpcTracker.failAll(sidecarId, 'disconnected');
    this.removeConnection(sidecarId);
  }

  // --------------- Protocol: RPC Dispatch ---------------

  /**
   * Send an RPC to a connected sidecar.
   * Returns the result, "detached" if initial timeout expires, or throws on failure.
   */
  async dispatchRPC(
    sidecarId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeouts: RPCTimeouts = DEFAULT_RPC_TIMEOUTS,
  ): Promise<unknown> {
    const connection = this.sidecarConnections.get(sidecarId);
    if (!connection) {
      throw new Error(`Sidecar ${sidecarId} is not connected`);
    }

    const rpcId = generateId();
    const request: RPCRequest = {
      type: 'rpc_request',
      id: rpcId,
      method,
      params,
    };

    // Send the request over WebSocket
    connection.sendRPC(request);

    // Track and await result
    return this.rpcTracker.dispatch(rpcId, sidecarId, method, timeouts);
  }

  /**
   * Send an RPC without tracking a response — for high-rate fire-and-forget
   * calls (realtime PCM frames) where a pending-tracker entry + timeout timer
   * per call is pure overhead. Silently drops if the sidecar isn't connected.
   */
  dispatchNotify(sidecarId: string, method: string, params: Record<string, unknown> = {}): void {
    const connection = this.sidecarConnections.get(sidecarId);
    if (!connection) return;
    connection.sendRPC({ type: 'rpc_request', id: generateId(), method, params });
  }

  /** Register a listener for RPC progress events */
  onProgress(listener: (sidecarId: string, rpcId: string, progress: number, message?: string) => void): void {
    this.progressListeners.add(listener);
  }

  /** Register a listener for sidecar events */
  onEvent(listener: (sidecarId: string, event: SidecarEvent) => void): void {
    this.eventListeners.add(listener);
  }

  // ───────────────────────── Realtime audio channel ─────────────────────────

  /** Register the pebble's dedicated audio pipe (replaces any stale one). */
  registerAudioChannel(sidecarId: string, ws: ServerWebSocket<unknown>): void {
    const prev = this.audioChannels.get(sidecarId);
    if (prev && prev !== ws) {
      try { prev.close(); } catch { /* already gone */ }
    }
    this.audioChannels.set(sidecarId, ws);
    console.log(`[SidecarManager] realtime audio channel open for ${sidecarId}`);
  }

  /** Deregister the audio pipe on close (only if it's still the current one). */
  unregisterAudioChannel(sidecarId: string, ws: ServerWebSocket<unknown>): void {
    if (this.audioChannels.get(sidecarId) === ws) {
      this.audioChannels.delete(sidecarId);
      console.log(`[SidecarManager] realtime audio channel closed for ${sidecarId}`);
    }
  }

  /** Route an inbound mic PCM frame from the audio channel to listeners. */
  handleAudioFrame(sidecarId: string, frame: Buffer): void {
    for (const listener of this.audioFrameListeners) listener(sidecarId, frame);
  }

  /** Listen for inbound mic PCM frames (wired to the realtime session). */
  onAudioFrame(listener: (sidecarId: string, frame: Buffer) => void): void {
    this.audioFrameListeners.add(listener);
  }

  /** A send handle for the audio pipe, or null when no channel is connected. */
  getAudioChannel(sidecarId: string): SidecarAudioChannel | null {
    const ws = this.audioChannels.get(sidecarId);
    if (!ws) return null;
    return {
      sendPCM: (buf: Buffer) => { try { ws.send(buf); } catch { /* gone */ } },
      sendFlush: () => { try { ws.send(JSON.stringify({ t: 'flush' })); } catch { /* gone */ } },
    };
  }

  /** Register a listener for sidecar connect events */
  onConnect(listener: (sidecarId: string) => void): void {
    this.connectListeners.add(listener);
  }

  // --------------- Helpers ---------------

  private toSidecarInfo(record: SidecarRecord): SidecarInfo {
    const conn = this.connected.get(record.id);
    const parsedCapabilities = record.capabilities ? JSON.parse(record.capabilities) : undefined;
    return {
      id: record.id,
      name: record.name,
      enrolled_at: record.enrolled_at,
      last_seen_at: record.last_seen_at,
      status: record.status,
      connected: !!conn,
      hostname: conn?.hostname ?? record.hostname ?? undefined,
      os: conn?.os ?? record.os ?? undefined,
      platform: conn?.platform ?? record.platform ?? undefined,
      capabilities: conn?.capabilities ?? parsedCapabilities,
      unavailable_capabilities: conn?.unavailableCapabilities,
      version: conn?.version ?? record.version ?? undefined,
      update_status: conn?.updateStatus,
    };
  }
}
