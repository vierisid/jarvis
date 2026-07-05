import type { Server, ServerWebSocket } from 'bun';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { isWithin } from '../util/path.ts';
import type { SidecarManager } from '../sidecar/manager.ts';

/** Constant-time string comparison to prevent timing attacks */
export type WSMessage = {
  type: 'chat' | 'command' | 'status' | 'stream' | 'error' | 'notification'
      | 'tts_start' | 'tts_text' | 'tts_end' | 'voice_start' | 'voice_end' | 'voice_text'
      | 'interview_start' | 'interview_user_message' | 'interview_assistant' | 'interview_done' | 'interview_error'
      | 'thinking_start' | 'thinking_end'
      | 'workflow_event'
      | 'goal_event'
      | 'site_event'
      // Premium realtime voice (gpt-realtime-2). `realtime_status` reports
      // session live/closed/error for the UI indicator; `realtime_transcript`
      // streams user/assistant transcript text. See docs/GPT_REALTIME_2_INTEGRATION.md.
      | 'realtime_status' | 'realtime_transcript'
      // Conv-tier task lifecycle event. Fires when the conversation LLM
      // delegates work to a task tier and during its life: started, then
      // completed | failed | cancelled. Tasks that pause for clarification
      // also fire a task_started event when they later resume.
      //
      // Payload:
      //   {
      //     type: 'task_started' | 'task_completed' | 'task_failed' | 'task_cancelled',
      //     task_id: string,        // stable id; same across pause + resume
      //     template: 'research' | 'code' | 'plan' | 'write' | 'general',
      //     intent: string,         // conv LLM's paraphrase of what to do
      //     status: 'running' | 'completed' | 'failed' | 'cancelled',
      //     elapsedMs: number,      // wall-clock since task started
      //     summary?: string,       // present on completed/failed/cancelled
      //   }
      //
      // Consuming (e.g. for a status pill component):
      //   const ws = new WebSocket('ws://host:port/ws');
      //   ws.onmessage = (e) => {
      //     const msg = JSON.parse(e.data);
      //     if (msg.type !== 'task_event') return;
      //     const p = msg.payload;
      //     switch (p.type) {
      //       case 'task_started':   pillsByTaskId.set(p.task_id, { template: p.template, intent: p.intent, startedAt: Date.now() }); break;
      //       case 'task_completed':
      //       case 'task_failed':
      //       case 'task_cancelled': pillsByTaskId.delete(p.task_id); break;
      //     }
      //   };
      //
      // Note: a task can fire task_started multiple times (initial dispatch
      // + each resume after a needs_input pause). Treat task_started as
      // "show pill"; treat any terminal event as "hide pill". Pauses
      // (needs_input) are NOT emitted as task_event - the conv LLM handles
      // them by asking the user via the regular chat stream.
      | 'task_event'
      // Emitted when a pending voice confirmation (clarifier / repeat-back)
      // expires from the server-side TTL sweep. Payload: { id: string }.
      // Clients should dismiss the corresponding card from their UI.
      | 'voice_confirmation_expired';
  payload: unknown;
  id?: string;
  priority?: 'urgent' | 'normal' | 'low';
  timestamp: number;
};

export type WSClientHandler = {
  onMessage: (msg: WSMessage, ws: ServerWebSocket<unknown>) => Promise<WSMessage | void>;
  onBinaryMessage?: (data: Buffer, ws: ServerWebSocket<unknown>) => Promise<void>;
  onConnect: (ws: ServerWebSocket<unknown>) => void;
  onDisconnect: (ws: ServerWebSocket<unknown>) => void;
};

type RouteHandler = (req: Request) => Response | Promise<Response>;
type MethodRoutes = { [method: string]: RouteHandler };

/** 401 HTML page loaded from auth-error.html */
const AUTH_ERROR_HTML = await Bun.file(path.join(import.meta.dir, 'auth-error.html')).text();

/** Inline script injected into authed HTML pages — strips ?token= from the hash. */
const TOKEN_STRIP_SCRIPT = `<script>(function(){var h=location.hash,i=h.indexOf('?');if(i===-1)return;var p=new URLSearchParams(h.slice(i));if(!p.has('token'))return;p.delete('token');var c=h.slice(0,i),r=p.toString();if(r)c+='?'+r;location.replace(location.pathname+location.search+c)})()</script>`;

function getCookie(req: Request, name: string): string | null {
  const cookies = req.headers.get('Cookie');
  if (!cookies) return null;
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function isPublicRoute(pathname: string, method: string): boolean {
  return (
    pathname === '/health' ||
    pathname === '/sidecar/connect' ||
    pathname === '/api/sidecars/.well-known/jwks.json' ||
    pathname.startsWith('/api/webhooks/') ||
    method === 'OPTIONS'
  );
}

/** Simple sliding-window rate limiter for proxy requests */
class ProxyRateLimiter {
  private windowMs: number;
  private maxRequests: number;
  private requests: number[] = [];

  constructor(windowMs = 10_000, maxRequests = 200) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  allow(): boolean {
    const now = Date.now();
    // Evict stale entries
    while (this.requests.length > 0 && this.requests[0]! < now - this.windowMs) {
      this.requests.shift();
    }
    if (this.requests.length >= this.maxRequests) return false;
    this.requests.push(now);
    return true;
  }
}

export class WebSocketServer {
  private server: Server<any> | null = null;
  private clients: Set<ServerWebSocket<unknown>> = new Set();
  private handler: WSClientHandler | null = null;
  private port: number;
  /** When set, bind a unix-domain socket instead of the TCP port (hosted mode). */
  private unixPath: string | null = null;
  /**
   * Synchronous `process.on('exit')` cleanup for the unix socket, registered
   * at bind. Guarantees the socket file is removed on ANY graceful process
   * exit regardless of shutdown-ordering (the daemon stops several slow
   * services before it reaches this one, and `jarvis stop`'s grace window can
   * SIGKILL mid-shutdown before an ordered stop() runs). Removed by stop() to
   * avoid stale handlers across restart-in-place. (SIGKILL is uncatchable; the
   * next start's pre-bind unlink covers that abnormal case.)
   */
  private exitCleanup: (() => void) | null = null;
  private startTime: number = 0;
  private apiRoutes: Map<string, MethodRoutes> = new Map();
  private staticDir: string | null = null;
  private publicDir: string | null = null;
  private sidecarManager: SidecarManager | null = null;
  /**
   * JWT-only by default: every non-public route requires a valid short-lived
   * sidecar access token (minted from an enrollment JWT). The ONLY way to
   * open the dashboard without one is the explicit config escape hatch
   * `auth.insecure_open_access: true` (pre-enrollment setup; see docs).
   */
  private insecureOpenAccess = false;
  private corsOrigin: string | null = null;
  private proxyLimiter = new ProxyRateLimiter();

  constructor(port: number = 3142, unixPath?: string) {
    this.port = port;
    this.unixPath = unixPath ?? null;
    this.corsOrigin = `http://localhost:${port}`;
  }

  setInsecureOpenAccess(enabled: boolean): void {
    this.insecureOpenAccess = enabled;
  }

  setHandler(handler: WSClientHandler): void {
    this.handler = handler;
  }

  setSidecarManager(manager: SidecarManager): void {
    this.sidecarManager = manager;
  }

  private siteProxy: import('../sites/proxy.ts').SiteProxy | null = null;

  setSiteProxy(proxy: import('../sites/proxy.ts').SiteProxy): void {
    this.siteProxy = proxy;
  }

  /**
   * Register API route handlers (method-based).
   * Example: setApiRoutes({ '/api/health': { GET: handler } })
   */
  setApiRoutes(routes: Record<string, MethodRoutes>): void {
    for (const [path, methods] of Object.entries(routes)) {
      this.apiRoutes.set(path, methods);
    }
  }

  /**
   * Set directory for serving static files (pre-built dashboard).
   */
  setStaticDir(dir: string): void {
    this.staticDir = dir;
  }

  /**
   * Set directory for serving public assets (models, WASM, etc.).
   * Falls through to this if file not found in staticDir.
   */
  setPublicDir(dir: string): void {
    this.publicDir = dir;
  }

  start(): void {
    if (this.server) {
      console.warn('[WebSocketServer] Server already running');
      return;
    }

    this.startTime = Date.now();
    const self = this;

    // Unix mode: remove a stale socket file from a previous run first, or
    // bind fails with EADDRINUSE even though nothing is listening. The socket
    // must also be BORN 0660 (umask), not chmod'd after the fact - between
    // bind and a post-hoc chmod the file briefly carries the process umask,
    // and on a shared host that window is the tenant boundary.
    let restoreUmask: number | null = null;
    if (this.unixPath) {
      try { require('node:fs').unlinkSync(this.unixPath); } catch { /* absent */ }
      restoreUmask = process.umask(0o117); // 0666 & ~0117 = 0660
    }

    // Bun accepts either { port } or { unix } (mutually exclusive variants of
    // a discriminated union). TypeScript can't narrow a conditional spread to
    // one variant, so the pair is cast to the port variant; at runtime Bun
    // receives exactly one of the two keys.
    const listenOpts = (this.unixPath ? { unix: this.unixPath } : { port: this.port }) as { port: number };
    this.server = Bun.serve<{ sidecar_id?: string; proxy_target?: string; _proxyUpstream?: WebSocket }>({
      ...listenOpts,
      idleTimeout: 30, // seconds — prevent timeout during heavy processing (OCR, PowerShell)

      async fetch(req, server) {
        const url = new URL(req.url);
        const pathname = url.pathname;

        // 0. Sidecar WebSocket upgrade (has its own JWT auth)
        if (pathname === '/sidecar/connect' && self.sidecarManager) {
          const authHeader = req.headers.get('Authorization');
          const token = authHeader?.startsWith('Bearer ')
            ? authHeader.slice(7)
            : null;
          if (!token) {
            return new Response('Missing token', { status: 401 });
          }

          const claims = await self.sidecarManager.validateToken(token);
          if (!claims) {
            return new Response('Invalid or revoked token', { status: 403 });
          }

          const success = server.upgrade(req, { data: { sidecar_id: claims.sid } });
          if (success) return undefined;
          return new Response('WebSocket upgrade failed', { status: 500 });
        }

        // 0b. Sidecar access-token mint. Authenticated by the long-lived
        //     enrollment JWT (Authorization: Bearer) — this and /sidecar/connect
        //     are the ONLY places that credential is accepted. Returns a
        //     short-lived access token the sidecar injects into its panel
        //     webviews; everything on the data plane (/api, /ws) authenticates
        //     with that access token, never the enrollment JWT.
        if (pathname === '/sidecar/token' && req.method === 'POST' && self.sidecarManager) {
          const authHeader = req.headers.get('Authorization');
          const enrollTok = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
          const claims = enrollTok ? await self.sidecarManager.validateToken(enrollTok) : null;
          if (!claims?.sid) {
            return new Response('Invalid or revoked token', { status: 403 });
          }
          const minted = await self.sidecarManager.issueAccessToken(claims.sid);
          if (!minted) {
            return Response.json({ error: 'mint failed' }, { status: 500 });
          }
          return Response.json({ access_token: minted.token, expires_in: minted.expiresIn });
        }

        // 1. Auth check. JWT-only by default: a request is authorized by a
        // valid short-lived sidecar ACCESS token (minted from the enrollment
        // JWT via /sidecar/token) - the sidecar's panel webviews carry one.
        // The long-lived enrollment JWT is deliberately NOT accepted here —
        // only on /sidecar/connect and the mint endpoint — so a leaked panel
        // credential is bounded to the access-token TTL instead of forever.
        // There is NO shared dashboard token: enroll a device or (setup only)
        // set auth.insecure_open_access.
        if (!self.insecureOpenAccess && !isPublicRoute(pathname, req.method)) {
          const accepts = async (tok: string | null): Promise<boolean> => {
            if (!tok) return false;
            if (self.sidecarManager && (await self.sidecarManager.verifyAccessToken(tok))) return true;
            return false;
          };
          const cookieToken = getCookie(req, 'token');
          if (!(await accepts(cookieToken))) {
            // Check ?token= query param — set cookie via Set-Cookie and redirect
            const queryToken = url.searchParams.get('token');
            if (await accepts(queryToken)) {
              const cleanParams = new URLSearchParams(url.searchParams);
              cleanParams.delete('token');
              const qs = cleanParams.toString();
              const redirectTo = pathname + (qs ? '?' + qs : '');
              // Mark the cookie Secure whenever the connection is TLS (directly,
              // or terminated upstream and forwarded) so the token can't leak
              // over a downgraded http request to the same host.
              const xfProto = (req.headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim();
              const isHttps = url.protocol === 'https:' || xfProto === 'https';
              const cookie = `token=${queryToken}; Path=/; SameSite=Lax; HttpOnly` +
                (isHttps ? '; Secure' : '');
              return new Response(null, {
                status: 302,
                headers: {
                  'Location': redirectTo || '/',
                  'Set-Cookie': cookie,
                },
              });
            }
            // No valid auth — API & WebSocket get JSON 401; browsers get the auth error page
            if (pathname.startsWith('/api/') || pathname === '/ws') {
              return Response.json({ error: 'Unauthorized' }, { status: 401 });
            }
            return new Response(AUTH_ERROR_HTML, {
              status: 401,
              headers: { 'Content-Type': 'text/html' },
            });
          }
        }

        // 2. WebSocket upgrade — validate Origin to block cross-origin connections
        //    (e.g., dev server iframes on different ports attempting ws://localhost:3142/ws).
        //    Allow when Origin's host matches the request Host header, which covers
        //    reverse-proxy deployments (Opencove, Cloudflare tunnel, ngrok, etc.).
        if (pathname === '/ws') {
          const origin = req.headers.get('origin');
          if (origin) {
            const expectedOrigin = self.corsOrigin || `http://localhost:${self.port}`;
            let sameHost = false;
            try {
              const originHost = new URL(origin).host;
              const requestHost = req.headers.get('host');
              sameHost = !!requestHost && originHost === requestHost;
            } catch {
              sameHost = false;
            }
            if (origin !== expectedOrigin && !sameHost) {
              return new Response('Forbidden: origin mismatch', { status: 403 });
            }
          }
          const success = server.upgrade(req, { data: {} });
          if (success) return undefined;
          return new Response('WebSocket upgrade failed', { status: 500 });
        }

        // 3. Health check (always public)
        if (pathname === '/health') {
          return Response.json({
            status: 'ok',
            uptime: Date.now() - self.startTime,
            clients: self.clients.size,
            timestamp: Date.now(),
          });
        }

        // 3b. Site builder proxy — intercept before API route matching
        if (self.siteProxy && pathname.startsWith('/api/sites/') && pathname.includes('/proxy')) {
          const match = self.siteProxy.matchProxy(pathname);
          if (match) {
            // Rate limit proxy requests
            if (!self.proxyLimiter.allow()) {
              return new Response(JSON.stringify({ error: 'Too many proxy requests' }), {
                status: 429,
                headers: { 'Content-Type': 'application/json', 'Retry-After': '10' },
              });
            }
            // WebSocket upgrade for HMR — bridge to dev server
            if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
              const targetUrl = self.siteProxy.getWebSocketTarget(match.projectId, match.subPath);
              if (!targetUrl) {
                return new Response('Dev server not running', { status: 502 });
              }
              const success = server.upgrade(req, {
                data: { proxy_target: targetUrl },
              });
              if (success) return undefined;
              return new Response('WebSocket upgrade failed', { status: 500 });
            }
            // HTTP proxy
            return self.siteProxy.proxyHttp(req, match.projectId, match.subPath);
          }
        }

        // 4. API routes
        if (pathname.startsWith('/api/')) {
          // Handle CORS preflight
          if (req.method === 'OPTIONS') {
            const allowedOrigin = self.corsOrigin || `http://localhost:${self.port}`;
            return new Response(null, {
              status: 204,
              headers: {
                'Access-Control-Allow-Origin': allowedOrigin,
                'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
              },
            });
          }

          // Try exact match first
          const exactRoute = self.apiRoutes.get(pathname);
          if (exactRoute) {
            const handler = exactRoute[req.method];
            if (handler) return handler(req);
            return new Response('Method Not Allowed', { status: 405 });
          }

          // Try parameterized routes (e.g., /api/vault/entities/:id)
          for (const [pattern, methods] of self.apiRoutes) {
            const params = matchRoute(pattern, pathname);
            if (params) {
              const handler = methods[req.method];
              if (handler) {
                // Attach params to request
                (req as any).params = params;
                return handler(req);
              }
              return new Response('Method Not Allowed', { status: 405 });
            }
          }

          return Response.json({ error: 'Not found' }, { status: 404 });
        }

        // 5a. Overlay widget (served from ui/ source, not dist/)
        if (pathname === '/overlay' && self.staticDir) {
          // overlay.html lives in the ui/ source directory (parent of dist/)
          const overlayPath = path.join(self.staticDir, '..', 'overlay.html');
          const overlayFile = Bun.file(overlayPath);
          if (await overlayFile.exists()) {
            if (!self.insecureOpenAccess) {
              const html = await overlayFile.text();
              return new Response(injectTokenStrip(html), { headers: { 'Content-Type': 'text/html' } });
            }
            return new Response(overlayFile, { headers: { 'Content-Type': 'text/html' } });
          }
        }

        // 5b. Static files (dashboard)
        if (self.staticDir) {
          let filePath: string;

          if (pathname === '/' || pathname === '/index.html') {
            filePath = path.resolve(self.staticDir, 'index.html');
          } else {
            // Serve JS/CSS/assets — resolve and validate within staticDir
            filePath = path.resolve(self.staticDir, '.' + pathname);
          }

          // Prevent path traversal outside staticDir
          if (!isWithin(filePath, path.resolve(self.staticDir))) {
            return new Response('Forbidden', { status: 403 });
          }

          const file = Bun.file(filePath);
          if (await file.exists()) {
            if (!self.insecureOpenAccess && filePath.endsWith('.html')) {
              const html = await file.text();
              return new Response(injectTokenStrip(html), { headers: { 'Content-Type': 'text/html' } });
            }
            return new Response(file);
          }
        }

        // 6. Public assets fallback (models, WASM, etc.)
        if (self.publicDir) {
          const publicPath = path.resolve(self.publicDir, '.' + pathname);
          // Prevent path traversal outside publicDir
          if (!isWithin(publicPath, path.resolve(self.publicDir))) {
            return new Response('Forbidden', { status: 403 });
          }
          const publicFile = Bun.file(publicPath);
          if (await publicFile.exists()) {
            return new Response(publicFile);
          }
        }

        // 7. Site builder catch-all — proxy unmatched paths to the active
        //    dev server using the __proj cookie set by the explicit proxy route.
        //    This handles absolute paths (/src/main.tsx, /node_modules/...) that
        //    frameworks emit and that don't match any JARVIS route.
        if (self.siteProxy) {
          // WebSocket upgrade (e.g. Vite HMR)
          if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            const targetUrl = self.siteProxy.getWebSocketTargetFromCookie(req, pathname);
            if (targetUrl) {
              const success = server.upgrade(req, { data: { proxy_target: targetUrl } });
              if (success) return undefined;
            }
          }
          // HTTP
          const proxyResp = await self.siteProxy.proxyCatchAll(req, pathname + url.search);
          if (proxyResp) return proxyResp;
        }

        return new Response('Not Found', { status: 404 });
      },

      websocket: {
        // Limit individual WS messages to 16 MB (defense against abusive HMR payloads)
        maxPayloadLength: 16 * 1024 * 1024,

        open(ws) {
          // HMR proxy WebSocket — bridge to dev server
          const proxyTarget = (ws.data as any)?.proxy_target as string | undefined;
          if (proxyTarget) {
            const upstream = new WebSocket(proxyTarget);
            (ws.data as any)._proxyUpstream = upstream;
            upstream.onmessage = (e) => {
              try {
                // Enforce size limit on upstream messages too
                const data = e.data;
                const size = typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength ?? 0;
                if (size > 16 * 1024 * 1024) return; // drop oversized frames
                ws.send(data);
              } catch { /* client gone */ }
            };
            upstream.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
            upstream.onclose = () => { try { ws.close(); } catch { /* ignore */ } };
            return;
          }

          const sidecarId = (ws.data as any)?.sidecar_id as string | undefined;
          if (sidecarId && self.sidecarManager) {
            self.sidecarManager.handleSidecarConnect(ws, sidecarId);
            return;
          }

          self.clients.add(ws);
          console.log('[WebSocketServer] Client connected. Total clients:', self.clients.size);
          self.handler?.onConnect(ws);
        },

        async message(ws, message) {
          // HMR proxy — forward to upstream dev server
          const proxyUpstream = (ws.data as any)?._proxyUpstream as WebSocket | undefined;
          if (proxyUpstream) {
            if (proxyUpstream.readyState === WebSocket.OPEN) {
              proxyUpstream.send(message);
            }
            return;
          }

          const sidecarId = (ws.data as any)?.sidecar_id as string | undefined;
          if (sidecarId && self.sidecarManager) {
            self.sidecarManager.handleSidecarMessage(ws, message);
            return;
          }

          // Binary frame = audio data (mic audio from client)
          if (message instanceof Buffer) {
            if (self.handler?.onBinaryMessage) {
              try {
                await self.handler.onBinaryMessage(message, ws);
              } catch (error) {
                console.error('[WebSocketServer] Error processing binary message:', error);
              }
            }
            return;
          }

          // Text frame = JSON message (existing protocol)
          try {
            const msg: WSMessage = JSON.parse(message.toString());
            console.log('[WebSocketServer] Received:', msg.type, msg.id);

            if (self.handler) {
              const response = await self.handler.onMessage(msg, ws);
              if (response) {
                ws.send(JSON.stringify(response));
              }
            }
          } catch (error) {
            console.error('[WebSocketServer] Error processing message:', error);
            const errorMsg: WSMessage = {
              type: 'error',
              payload: {
                message: error instanceof Error ? error.message : 'Unknown error',
              },
              timestamp: Date.now(),
            };
            ws.send(JSON.stringify(errorMsg));
          }
        },

        pong(ws) {
          const sidecarId = (ws.data as any)?.sidecar_id as string | undefined;
          if (sidecarId && self.sidecarManager) {
            self.sidecarManager.handleSidecarPong(sidecarId);
          }
        },

        close(ws) {
          // HMR proxy cleanup
          const proxyUpstream = (ws.data as any)?._proxyUpstream as WebSocket | undefined;
          if (proxyUpstream) {
            try { proxyUpstream.close(); } catch { /* ignore */ }
            return;
          }

          const sidecarId = (ws.data as any)?.sidecar_id as string | undefined;
          if (sidecarId && self.sidecarManager) {
            self.sidecarManager.handleSidecarDisconnect(sidecarId);
            return;
          }

          self.clients.delete(ws);
          console.log('[WebSocketServer] Client disconnected. Total clients:', self.clients.size);
          self.handler?.onDisconnect(ws);
        },
      },
    });

    if (restoreUmask !== null) process.umask(restoreUmask);
    if (this.unixPath) {
      // Caddy (same group) must be able to connect; the socket dir itself is
      // the per-tenant boundary. The umask above made the socket 0660 at
      // birth; verify rather than trust, and fail CLOSED if it is wrong.
      const fs = require('node:fs');
      const mode = fs.statSync(this.unixPath).mode & 0o777;
      if (mode !== 0o660) {
        try { fs.chmodSync(this.unixPath, 0o660); } catch { /* verified below */ }
        if ((fs.statSync(this.unixPath).mode & 0o777) !== 0o660) {
          this.stop();
          throw new Error(`[WebSocketServer] Socket ${this.unixPath} has mode ${mode.toString(8)}, expected 660 - refusing to serve`);
        }
      }
      // Guarantee the socket is gone on any graceful process exit, whatever
      // the shutdown ordering. Capture the path so the handler can't race a
      // later reassignment of this.unixPath.
      const socketPath = this.unixPath;
      this.exitCleanup = () => {
        try { require('node:fs').unlinkSync(socketPath); } catch { /* already gone */ }
      };
      process.once('exit', this.exitCleanup);
      console.log(`[WebSocketServer] Started on unix:${this.unixPath} (no TCP port bound)`);
    } else {
      console.log(`[WebSocketServer] Started on ws://localhost:${this.port}/ws`);
      console.log(`[WebSocketServer] Health endpoint: http://localhost:${this.port}/health`);
    }
    if (this.staticDir) {
      console.log(`[WebSocketServer] Dashboard: http://localhost:${this.port}/`);
    }
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      this.clients.clear();
      // Remove the socket file so ops probes don't see a dead-but-present
      // socket (the pre-bind unlink only covers the NEXT start).
      if (this.unixPath) {
        try { require('node:fs').unlinkSync(this.unixPath); } catch { /* absent */ }
      }
      // Drop the exit-time cleanup: an explicit stop already removed the
      // socket, and leaving it registered would let a restart-in-place on a
      // new path be unlinked by this old instance's handler at process exit.
      if (this.exitCleanup) {
        process.removeListener('exit', this.exitCleanup);
        this.exitCleanup = null;
      }
      console.log('[WebSocketServer] Stopped');
    }
  }

  broadcast(message: WSMessage): void {
    const payload = JSON.stringify(message);
    let sent = 0;

    for (const client of this.clients) {
      try {
        client.send(payload);
        sent++;
      } catch (error) {
        console.error('[WebSocketServer] Error broadcasting to client:', error);
      }
    }

    // Only log errors or when no clients received the message
    if (sent === 0 && this.clients.size > 0) {
      console.warn(`[WebSocketServer] Broadcast failed: 0/${this.clients.size} clients received message`);
    }
  }

  send(client: ServerWebSocket<unknown>, message: WSMessage): void {
    try {
      client.send(JSON.stringify(message));
    } catch (error) {
      console.error('[WebSocketServer] Error sending to client:', error);
    }
  }

  /**
   * Unicast a JSON message to a specific client (e.g. tts_start/tts_end signals).
   */
  sendToClient(ws: ServerWebSocket<unknown>, message: WSMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('[WebSocketServer] Error unicasting to client:', error);
    }
  }

  /**
   * Unicast binary data to a specific client (e.g. TTS audio chunks).
   */
  sendBinary(ws: ServerWebSocket<unknown>, data: Buffer): void {
    try {
      ws.sendBinary(data);
    } catch (error) {
      console.error('[WebSocketServer] Error sending binary to client:', error);
    }
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getPort(): number {
    return this.port;
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getClients(): Set<ServerWebSocket<unknown>> {
    return this.clients;
  }
}

/**
 * Inject the token-stripping script into an HTML page (right after <head>).
 */
function injectTokenStrip(html: string): string {
  const headIdx = html.indexOf('<head>');
  if (headIdx !== -1) {
    return html.slice(0, headIdx + 6) + TOKEN_STRIP_SCRIPT + html.slice(headIdx + 6);
  }
  const htmlIdx = html.indexOf('<html');
  if (htmlIdx !== -1) {
    const closeTag = html.indexOf('>', htmlIdx);
    if (closeTag !== -1) {
      return html.slice(0, closeTag + 1) + TOKEN_STRIP_SCRIPT + html.slice(closeTag + 1);
    }
  }
  return TOKEN_STRIP_SCRIPT + html;
}

/**
 * Match a route pattern like '/api/vault/entities/:id/facts' against a pathname.
 * Returns params object if matched, null otherwise.
 */
function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  // Skip wildcard patterns
  if (pattern.includes('*')) return null;

  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i]!.startsWith(':')) {
      params[patternParts[i]!.slice(1)] = pathParts[i]!;
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }

  return Object.keys(params).length > 0 ? params : null;
}
