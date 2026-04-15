/**
 * Sidecar Manager
 *
 * Brain-side service that manages sidecar enrollment, authentication,
 * and connection tracking. Handles ES256 key pair lifecycle and JWT signing.
 */

import { generateKeyPair, exportJWK, exportPKCS8, exportSPKI, importPKCS8, importSPKI, SignJWT, jwtVerify, createRemoteJWKSet, type JWK } from 'jose';
import { existsSync, mkdirSync } from 'node:fs';
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
import { EventScheduler } from './scheduler.ts';
import { RPCTracker } from './rpc.ts';
import { SidecarConnection } from './connection.ts';

const ALG = 'ES256';
const KEY_DIR_NAME = 'sidecar-keys';
const PRIVATE_KEY_FILE = 'private.pem';
const PUBLIC_KEY_FILE = 'public.pem';

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
  private sidecarConnections = new Map<string, SidecarConnection>();
  private progressListeners = new Set<(sidecarId: string, rpcId: string, progress: number, message?: string) => void>();
  private eventListeners = new Set<(sidecarId: string, event: SidecarEvent) => void>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.scheduler = new EventScheduler();
    this.rpcTracker = new RPCTracker();
  }

  /**
   * Set the brain's external URL (used in JWT claims).
   * Must be called before enrolling sidecars.
   * Example: "shiny-panda.domain.com" or "localhost:3142"
   */
  setBrainUrl(url: string): void {
    this.brainUrl = url;
  }

  // --------------- Service Interface ---------------

  async start(): Promise<void> {
    this._status = 'starting';
    try {
      await this.loadOrGenerateKeys();

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
      const sidecarEventTypes = ['screen_capture', 'context_changed', 'idle_detected', 'clipboard_change'];
      const sidecarEventHandler = async (sidecarId: string, event: SidecarEvent) => {
        for (const listener of this.eventListeners) {
          listener(sidecarId, event);
        }
      };
      for (const type of sidecarEventTypes) {
        this.scheduler.on(type, sidecarEventHandler);
      }

      this.rpcTracker.onDetachedComplete((rpcId, result, error) => {
        if (error) {
          console.warn(`[SidecarManager] Detached RPC ${rpcId} failed:`, error.message);
        } else {
          console.log(`[SidecarManager] Detached RPC ${rpcId} completed`);
        }
      });

      this.scheduler.start();

      this._status = 'running';
      console.log('[SidecarManager] Started — keys loaded, scheduler running');
    } catch (err) {
      this._status = 'error';
      throw err;
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';

    // Stop scheduler
    this.scheduler.stop();

    // Close all sidecar connections and fail pending RPCs
    for (const [id, conn] of this.sidecarConnections) {
      this.rpcTracker.failAll(id, 'manager stopping');
      conn.close();
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
    if (existsSync(this.privateKeyPath) && existsSync(this.publicKeyPath)) {
      await this.loadKeys();
      console.log('[SidecarManager] Loaded existing ES256 key pair');
    } else {
      await this.generateKeys();
      console.log('[SidecarManager] Generated new ES256 key pair');
    }

    // Export public key as JWK for the JWKS endpoint
    this.publicJwk = await exportJWK(this.publicKey!);
    this.keyId = this.publicJwk.x ?? 'default'; // use x-coordinate as kid (stable, unique)
  }

  private async generateKeys(): Promise<void> {
    mkdirSync(this.keysDir, { recursive: true });

    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    this.privateKey = privateKey;
    this.publicKey = publicKey;

    // Export to PEM and write to disk
    const pkcs8 = await exportPKCS8(privateKey);
    const spki = await exportSPKI(publicKey);

    await Bun.write(this.privateKeyPath, pkcs8);
    await Bun.write(this.publicKeyPath, spki);
  }

  private async loadKeys(): Promise<void> {
    const privatePem = await Bun.file(this.privateKeyPath).text();
    const publicPem = await Bun.file(this.publicKeyPath).text();

    this.privateKey = await importPKCS8(privatePem, ALG, { extractable: true });
    this.publicKey = await importSPKI(publicPem, ALG, { extractable: true });
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
   */
  async enrollSidecar(name: string, enrollmentOrigin?: string): Promise<{ token: string; sidecar: SidecarRecord }> {
    if (!this.privateKey) throw new Error('SidecarManager not started');
    if (!this.brainUrl) throw new Error('Brain URL not configured — call setBrainUrl() first');

    // Validate name
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 64) {
      throw new Error('Sidecar name must be 1-64 characters');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      throw new Error('Sidecar name may only contain letters, numbers, hyphens, and underscores');
    }

    // Check uniqueness
    const db = getDb();
    const existing = db.query('SELECT id FROM sidecars WHERE name = ? AND status = ?').get(trimmed, 'enrolled') as { id: string } | null;
    if (existing) {
      throw new Error(`Sidecar "${trimmed}" is already enrolled`);
    }

    const id = generateId();
    const tokenId = generateId();

    const { brainWs, jwksUrl } = this.buildEnrollmentUrls(enrollmentOrigin || this.brainUrl);

    // Sign JWT
    const token = await new SignJWT({
      sid: id,
      name: trimmed,
      brain: brainWs,
      jwks: jwksUrl,
    } satisfies Omit<SidecarTokenClaims, 'sub' | 'jti' | 'iat'>)
      .setProtectedHeader({ alg: ALG, kid: this.keyId })
      .setSubject(`sidecar:${id}`)
      .setJti(tokenId)
      .setIssuedAt()
      .sign(this.privateKey);

    // Store in database
    db.run(
      'INSERT INTO sidecars (id, name, token_id) VALUES (?, ?, ?)',
      [id, trimmed, tokenId],
    );

    const sidecar = db.query('SELECT * FROM sidecars WHERE id = ?').get(id) as SidecarRecord;
    console.log(`[SidecarManager] Enrolled sidecar "${trimmed}" (${id})`);

    return { token, sidecar };
  }

  private buildEnrollmentUrls(brainBase: string): { brainWs: string; jwksUrl: string } {
    const normalized = brainBase.trim();

    if (/^https?:\/\//.test(normalized) || /^wss?:\/\//.test(normalized)) {
      const parsed = new URL(normalized);
      const host = parsed.host;
      const wsProtocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss' : 'ws';
      const httpProtocol = parsed.protocol === 'wss:' ? 'https' : parsed.protocol === 'ws:' ? 'http' : parsed.protocol.replace(':', '');
      return {
        brainWs: `${wsProtocol}://${host}/sidecar/connect`,
        jwksUrl: `${httpProtocol}://${host}/api/sidecars/.well-known/jwks.json`,
      };
    }

    const isSecure = !normalized.includes('localhost') && !normalized.match(/:\d+$/);
    const wsProtocol = isSecure ? 'wss' : 'ws';
    const httpProtocol = isSecure ? 'https' : 'http';
    return {
      brainWs: `${wsProtocol}://${normalized}/sidecar/connect`,
      jwksUrl: `${httpProtocol}://${normalized}/api/sidecars/.well-known/jwks.json`,
    };
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
      this.connected.delete(id);
      console.log(`[SidecarManager] Revoked and removed sidecar ${id}`);
      return true;
    }
    return false;
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
    this.connected.set(sidecar.id, sidecar);
    // Persist connection details to DB so they're available even when offline
    const db = getDb();
    db.run(
      `UPDATE sidecars SET last_seen_at = datetime('now'), hostname = ?, os = ?, platform = ?, capabilities = ? WHERE id = ?`,
      [sidecar.hostname, sidecar.os, sidecar.platform, JSON.stringify(sidecar.capabilities), sidecar.id],
    );
    console.log(`[SidecarManager] Sidecar connected: ${sidecar.name} (${sidecar.id})`);
  }

  /** Remove a connected sidecar (called on WS close) */
  removeConnection(id: string): void {
    const sc = this.connected.get(id);
    this.connected.delete(id);
    if (sc) {
      console.log(`[SidecarManager] Sidecar disconnected: ${sc.name} (${id})`);
    }
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

      // Check sidecar is still enrolled
      if (!claims.sid || !this.isEnrolled(claims.sid)) {
        return null;
      }

      return claims;
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
          const record = this.getSidecar(sidecarId);
          this.registerConnection({
            id: sidecarId,
            name: record?.name ?? parsed.hostname ?? sidecarId,
            hostname: parsed.hostname ?? 'unknown',
            os: parsed.os ?? 'unknown',
            platform: parsed.platform ?? 'unknown',
            capabilities: parsed.capabilities ?? [],
            unavailableCapabilities: parsed.unavailable_capabilities ?? [],
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

  /** Register a listener for RPC progress events */
  onProgress(listener: (sidecarId: string, rpcId: string, progress: number, message?: string) => void): void {
    this.progressListeners.add(listener);
  }

  /** Register a listener for sidecar events */
  onEvent(listener: (sidecarId: string, event: SidecarEvent) => void): void {
    this.eventListeners.add(listener);
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
    };
  }
}
