/**
 * WebhookManager — manages inbound webhook endpoints for workflow triggers
 *
 * Each workflow can have a unique webhook path. Requests are validated
 * against an optional HMAC-SHA256 secret (X-Jarvis-Signature header).
 */

// ── Types ──

export type WebhookRoute = {
  workflowId: string;
  path: string;
  secret: string | null;
  registeredAt: number;
};

export type WebhookTriggerCallback = (workflowId: string, data: Record<string, unknown>) => void;

// ── Helpers ──

/**
 * Compute an HMAC-SHA256 hex digest for the given body using the Web Crypto API.
 * Works in both Bun and browser contexts.
 */
async function computeHmac(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── WebhookManager ──

export class WebhookManager {
  private routes: Map<string, WebhookRoute> = new Map();
  private triggerCallback: WebhookTriggerCallback | null = null;

  /**
   * Register a workflow webhook.
   * @returns the webhook path (e.g. "/webhooks/wf_abc123")
   */
  register(workflowId: string, secret?: string): string {
    const path = `/webhooks/${workflowId}`;

    this.routes.set(workflowId, {
      workflowId,
      path,
      secret: secret ?? null,
      registeredAt: Date.now(),
    });

    console.log(`[WebhookManager] Registered webhook for workflow "${workflowId}" at ${path}`);
    return path;
  }

  /**
   * Remove a workflow's webhook registration.
   */
  unregister(workflowId: string): void {
    if (this.routes.delete(workflowId)) {
      console.log(`[WebhookManager] Unregistered webhook for workflow "${workflowId}"`);
    }
  }

  /**
   * Handle an inbound webhook request.
   *
   * Validates the optional HMAC secret, extracts the JSON body, and fires
   * the trigger callback. Returns a proper HTTP Response.
   */
  async handleRequest(workflowId: string, req: Request): Promise<Response> {
    const route = this.routes.get(workflowId);

    if (!route) {
      return new Response(JSON.stringify({ error: 'Webhook not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Read raw body once
    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return new Response(JSON.stringify({ error: 'Failed to read request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate HMAC signature if a secret is configured
    if (route.secret) {
      const signature = req.headers.get('x-jarvis-signature') ?? req.headers.get('X-Jarvis-Signature');

      if (!signature) {
        return new Response(JSON.stringify({ error: 'Missing signature header' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const expected = await computeHmac(route.secret, rawBody);

      // Constant-time comparison to prevent timing attacks
      if (!timingSafeEqual(signature.toLowerCase(), expected.toLowerCase())) {
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Parse body
    let data: Record<string, unknown> = {};
    if (rawBody.trim()) {
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        } else {
          data = { body: parsed };
        }
      } catch {
        // Not JSON — pass as raw string
        data = { body: rawBody };
      }
    }

    // Enrich with request metadata
    data._webhook = {
      method: req.method,
      url: req.url,
      timestamp: Date.now(),
      headers: Object.fromEntries(req.headers.entries()),
    };

    // Fire callback (non-blocking)
    if (this.triggerCallback) {
      try {
        this.triggerCallback(workflowId, data);
      } catch (err) {
        console.error(`[WebhookManager] Trigger callback threw for workflow "${workflowId}":`, err);
      }
    } else {
      console.warn(`[WebhookManager] No trigger callback set; webhook fired for "${workflowId}" but nothing will execute`);
    }

    return new Response(JSON.stringify({ ok: true, workflowId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Set the callback invoked when a webhook fires successfully.
   */
  setTriggerCallback(cb: WebhookTriggerCallback): void {
    this.triggerCallback = cb;
  }

  /**
   * Returns the map of all registered routes keyed by workflowId.
   */
  getRoutes(): Map<string, WebhookRoute> {
    return new Map(this.routes);
  }
}

// ── Utilities ──

/**
 * Constant-time string comparison to prevent timing-based secret leakage.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
