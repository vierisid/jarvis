import type { Server, ServerWebSocket } from 'bun';
import path from 'node:path';
import type { SidecarManager } from '../sidecar/manager.ts';

export type WSMessage = {
  type: 'chat' | 'command' | 'status' | 'stream' | 'error' | 'notification'
      | 'tts_start' | 'tts_end' | 'voice_start' | 'voice_end'
      | 'workflow_event'
      | 'goal_event';
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

export class WebSocketServer {
  private server: Server<any> | null = null;
  private clients: Set<ServerWebSocket<unknown>> = new Set();
  private handler: WSClientHandler | null = null;
  private port: number;
  private startTime: number = 0;
  private apiRoutes: Map<string, MethodRoutes> = new Map();
  private staticDir: string | null = null;
  private publicDir: string | null = null;
  private sidecarManager: SidecarManager | null = null;
  private authToken: string | null = null;

  constructor(port: number = 3142) {
    this.port = port;
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  setHandler(handler: WSClientHandler): void {
    this.handler = handler;
  }

  setSidecarManager(manager: SidecarManager): void {
    this.sidecarManager = manager;
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

    this.server = Bun.serve<{ sidecar_id?: string }>({
      port: this.port,

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

        // 1. Auth check (if configured)
        if (self.authToken && !isPublicRoute(pathname, req.method)) {
          const cookieToken = getCookie(req, 'token');
          if (cookieToken !== self.authToken) {
            // Check ?token= query param — set cookie via Set-Cookie and redirect
            const queryToken = url.searchParams.get('token');
            if (queryToken === self.authToken) {
              const cleanParams = new URLSearchParams(url.searchParams);
              cleanParams.delete('token');
              const qs = cleanParams.toString();
              const redirectTo = pathname + (qs ? '?' + qs : '');
              return new Response(null, {
                status: 302,
                headers: {
                  'Location': redirectTo || '/',
                  'Set-Cookie': `token=${queryToken}; Path=/; SameSite=Lax`,
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

        // 2. WebSocket upgrade
        if (pathname === '/ws') {
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

        // 4. API routes
        if (pathname.startsWith('/api/')) {
          // Handle CORS preflight
          if (req.method === 'OPTIONS') {
            return new Response(null, {
              status: 204,
              headers: {
                'Access-Control-Allow-Origin': '*',
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
            if (self.authToken) {
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
            filePath = path.join(self.staticDir, 'index.html');
          } else {
            // Serve JS/CSS/assets
            filePath = path.join(self.staticDir, pathname);
          }

          const file = Bun.file(filePath);
          if (await file.exists()) {
            if (self.authToken && filePath.endsWith('.html')) {
              const html = await file.text();
              return new Response(injectTokenStrip(html), { headers: { 'Content-Type': 'text/html' } });
            }
            return new Response(file);
          }
        }

        // 6. Public assets fallback (models, WASM, etc.)
        if (self.publicDir) {
          const publicPath = path.join(self.publicDir, pathname);
          const publicFile = Bun.file(publicPath);
          if (await publicFile.exists()) {
            return new Response(publicFile);
          }
        }

        return new Response('Not Found', { status: 404 });
      },

      websocket: {
        open(ws) {
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

    console.log(`[WebSocketServer] Started on ws://localhost:${this.port}/ws`);
    console.log(`[WebSocketServer] Health endpoint: http://localhost:${this.port}/health`);
    if (this.staticDir) {
      console.log(`[WebSocketServer] Dashboard: http://localhost:${this.port}/`);
    }
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      this.clients.clear();
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

    console.log(`[WebSocketServer] Broadcast to ${sent}/${this.clients.size} clients`);
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
