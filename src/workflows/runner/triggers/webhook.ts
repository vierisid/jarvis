/**
 * WebhookManager — manages inbound webhook endpoints for workflow triggers
 *
 * Each workflow can have a unique webhook path. Requests are validated
 * against an optional HMAC-SHA256 secret (X-Jarvis-Signature header).
 */

import { KeyedRateLimiter } from './rate-limiter.ts';

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

/** Per-flow and global ingress budgets. Generous for real integrations, fatal for a flood. */
export const WEBHOOK_PER_FLOW_PER_MINUTE = 60;
export const WEBHOOK_GLOBAL_PER_MINUTE = 600;
/** Budget for requests to a secret-protected flow that fail the signature. */
export const WEBHOOK_BAD_SIGNATURE_PER_MINUTE = 30;
/**
 * Body cap for the public ingress. The body is the real per-request cost
 * (the HMAC over it is microseconds), and the server's own default cap is
 * far larger than any webhook payload.
 */
export const WEBHOOK_MAX_BODY_BYTES = 1_000_000;

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });

export class WebhookManager {
  private routes: Map<string, WebhookRoute> = new Map();
  private triggerCallback: WebhookTriggerCallback | null = null;
  private perFlow = new KeyedRateLimiter(60_000, WEBHOOK_PER_FLOW_PER_MINUTE);
  private global = new KeyedRateLimiter(60_000, WEBHOOK_GLOBAL_PER_MINUTE);
  private badSignature = new KeyedRateLimiter(60_000, WEBHOOK_BAD_SIGNATURE_PER_MINUTE);
  private canAccept: (() => boolean) | null = null;

  /** Test hook: swap the limiters (e.g. with a fake clock). */
  setRateLimiters(perFlow: KeyedRateLimiter, global: KeyedRateLimiter, badSignature?: KeyedRateLimiter): void {
    this.perFlow = perFlow;
    this.global = global;
    if (badSignature) this.badSignature = badSignature;
  }

  /**
   * Backlog probe. When it answers false the request gets a 503 with
   * Retry-After, so the sender retries later instead of being told "ok"
   * about a run that was never queued.
   */
  setCapacityCheck(fn: (() => boolean) | null): void {
    this.canAccept = fn;
  }

  /**
   * Charge the ingress budgets for one accepted request, or return the 429
   * to send. Both budgets are checked before either is charged, and the
   * Retry-After comes from the budget that refused.
   */
  private chargeBudgets(workflowId: string): Response | null {
    if (!this.perFlow.check(workflowId)) {
      return json(429, { error: 'Too many requests' }, { 'Retry-After': String(this.perFlow.retryAfterSeconds(workflowId)) });
    }
    if (!this.global.check('*')) {
      return json(429, { error: 'Too many requests' }, { 'Retry-After': String(this.global.retryAfterSeconds('*')) });
    }
    this.perFlow.record(workflowId);
    this.global.record('*');
    return null;
  }

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

    // This route is public and every accepted request becomes a queued flow
    // run, so the budgets are charged before the body is read. For a
    // secret-protected flow the charge waits until the signature checks out:
    // otherwise anyone holding the (non-secret) flow id could exhaust the
    // budget with unsigned junk and lock out the legitimate signed sender.
    // Signature failures draw on their own small budget instead.
    // Backlog first, before any budget is spent, so a sender retrying into a
    // still-full queue keeps getting the 503 and its Retry-After rather than
    // flipping to 429. Refusing beats queueing into a pile the worker is
    // not draining, or worse, saying "ok" and dropping.
    if (this.canAccept && !this.canAccept()) {
      return json(503, { error: 'Service busy, retry later' }, { 'Retry-After': '30' });
    }

    const badKey = `${workflowId}:bad-signature`;
    if (!route.secret) {
      const limited = this.chargeBudgets(workflowId);
      if (limited) return limited;
    }
    // For a secret-protected flow the signature is verified first, then the
    // budgets are charged. The bad-signature budget is consulted only AFTER
    // a failed check (below): consulting it before would let an unsigned
    // flood lock out the legitimate signed sender, which is the very thing
    // the split exists to prevent. The cost of that ordering is one body
    // read plus one HMAC per junk request, both bounded and cheap.

    // Body cap: declared size first (no read at all), then the actual size
    // for chunked bodies that declare none.
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) {
      return json(413, { error: 'Payload too large' });
    }

    // Read raw body once
    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return json(400, { error: 'Failed to read request body' });
    }
    if (rawBody.length > WEBHOOK_MAX_BODY_BYTES) {
      return json(413, { error: 'Payload too large' });
    }

    // Validate HMAC signature if a secret is configured
    if (route.secret) {
      const signature = req.headers.get('x-jarvis-signature') ?? req.headers.get('X-Jarvis-Signature');

      const rejectUnsigned = (message: string): Response => {
        if (!this.badSignature.allow(badKey)) {
          return json(429, { error: 'Too many requests' }, { 'Retry-After': String(this.badSignature.retryAfterSeconds(badKey)) });
        }
        return json(401, { error: message });
      };

      if (!signature) return rejectUnsigned('Missing signature header');
      // A real signature is exactly 64 hex chars; anything else is refused
      // without spending a hash on it.
      if (!HEX_SHA256.test(signature)) return rejectUnsigned('Invalid signature');

      const expected = await computeHmac(route.secret, rawBody);

      // Constant-time comparison to prevent timing attacks
      if (!timingSafeEqual(signature.toLowerCase(), expected.toLowerCase())) {
        return rejectUnsigned('Invalid signature');
      }

      const limited = this.chargeBudgets(workflowId);
      if (limited) return limited;
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
