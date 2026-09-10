import type { JarvisConfig } from '../config/types.ts';
import { INSTANCE_SIGNATURE_HEADER, signWithSecret } from '../integrations/google-signature.ts';
import { redactSecrets } from '../util/redact.ts';

/**
 * This instance's owner's billing summary, read from the control plane
 * (control plane: docs/BILLING.md "Billing inside the brain", D36).
 *
 * ## Why the instance reads it
 *
 * The Settings -> Billing page renders inside the sidecar's webview, which has
 * no session with the control plane's user API: sign-in happens in the system
 * browser, and that cookie never reaches this origin. So this daemon reads the
 * summary AS THE INSTANCE, signing with the per-instance billing secret the
 * control plane renders into config.yaml, the same way the usage meter does.
 *
 * ## Read-only
 *
 * Nothing here changes billing, and nothing may: the secret sits in a file this
 * process reads, and this process runs an assistant. Every change is a link to
 * the account page (`page_url`), opened in the system browser where the user's
 * own session authorizes it. See `billingLinks`.
 *
 * ## What never leaves this module
 *
 * The endpoint, the instance id and the secret. The route above hands the UI
 * the parsed summary and the account links only; failures log to the operator
 * console and read as "unavailable" to the user.
 */

export interface HostedBillingPrice {
  interval: string;
  /** Minor units. */
  unitAmount: number;
  currency: string;
}

export interface HostedBillingPlan {
  key: string;
  name: string;
  quantity: number;
  prices: HostedBillingPrice[];
}

export interface HostedBillingSubscription {
  status: string;
  /** ISO-8601, or null when not known. */
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /** Set to end at `currentPeriodEnd` (or `cancelAt`) rather than renew. */
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  /** How long a past-due subscription keeps access. */
  graceUntil: string | null;
  startedAt: string | null;
}

export interface HostedBillingUpcomingInvoice {
  amountDueCents: number;
  currency: string;
  /** When it will be charged. */
  date: string | null;
}

export interface HostedBillingPaymentMethod {
  /** Card brand ("visa"), or the method type ("sepa_debit") for non-cards. */
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

export interface HostedBillingPayment {
  id: string;
  /** NET of tax; gross = amountCents + taxCents. Refunds are negative. */
  amountCents: number;
  taxCents: number;
  currency: string;
  paidAt: string;
  invoiceNumber: string | null;
  /** https only; opened in the system browser. */
  invoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export interface HostedBillingSummary {
  account: { email: string };
  subscription: HostedBillingSubscription | null;
  plans: HostedBillingPlan[];
  upcomingInvoice: HostedBillingUpcomingInvoice | null;
  /** null = the control plane could not read the card processor right now. */
  paymentMethods: HostedBillingPaymentMethod[] | null;
  /** Newest first. */
  payments: HostedBillingPayment[];
}

/** The four fields that must travel together, or billing is off. */
export interface HostedBillingConfig {
  url: string;
  instanceId: string;
  secret: string;
  pageUrl: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isHttpUrl(value: string, httpsOnly = false): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || (!httpsOnly && u.protocol === 'http:');
  } catch {
    return false;
  }
}

export function readHostedBillingConfig(config: JarvisConfig): HostedBillingConfig | null {
  const block = config.usejarvis_billing;
  if (!block || typeof block !== 'object') return null;
  const url = str(block.url);
  const instanceId = str(block.instance_id);
  const secret = str(block.secret);
  const pageUrl = str(block.page_url);
  // A partial set cannot authenticate (or cannot send anyone anywhere), and
  // treating it as present would poll a control plane that answers 401.
  if (!url || !instanceId || !secret || !pageUrl) return null;
  // page_url becomes a link the user clicks: nothing but http(s) may pass.
  if (!isHttpUrl(url, true) || !isHttpUrl(pageUrl)) return null;
  return { url, instanceId, secret, pageUrl };
}

/**
 * Where each billing action sends the user: the account billing page, with the
 * action it should open. The page authorizes every one of them with the user's
 * own session; an action it does not know simply shows the billing page.
 */
export interface BillingLinks {
  page: string;
  /** The processor's customer portal home (invoices, renew, everything). */
  manage: string;
  paymentMethod: string;
  changePlan: string;
  cancel: string;
}

export function billingLinks(pageUrl: string): BillingLinks {
  const withAction = (action: string) => {
    const u = new URL(pageUrl);
    u.searchParams.set('action', action);
    return u.toString();
  };
  return {
    page: new URL(pageUrl).toString(),
    manage: withAction('manage'),
    paymentMethod: withAction('payment-method'),
    changePlan: withAction('change-plan'),
    cancel: withAction('cancel'),
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────────
//
// Validated, not trusted: a field we do not recognise must read as absent rather
// than render as `undefined`, and a response missing the parts every section
// needs reads as "unavailable" as a whole. Fields the control plane added later
// (cancelAtPeriodEnd, invoice links, the upcoming charge) are OPTIONAL here, so a
// newer brain against an older control plane degrades to fewer details.

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const date = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
const httpsOrNull = (v: unknown): string | null =>
  typeof v === 'string' && isHttpUrl(v, true) ? v : null;

function parsePlan(v: unknown): HostedBillingPlan | null {
  if (!isObj(v) || typeof v.name !== 'string') return null;
  const prices = Array.isArray(v.prices)
    ? v.prices.flatMap((p): HostedBillingPrice[] => {
        if (!isObj(p)) return [];
        const unitAmount = num(p.unitAmount);
        if (unitAmount === null || typeof p.interval !== 'string' || typeof p.currency !== 'string') return [];
        return [{ interval: p.interval, unitAmount, currency: p.currency }];
      })
    : [];
  return {
    key: typeof v.key === 'string' ? v.key : '',
    name: v.name,
    quantity: num(v.quantity) ?? 1,
    prices,
  };
}

function parseSubscription(v: unknown): HostedBillingSubscription | null {
  if (!isObj(v) || typeof v.status !== 'string') return null;
  return {
    status: v.status,
    currentPeriodStart: date(v.currentPeriodStart),
    currentPeriodEnd: date(v.currentPeriodEnd),
    cancelAtPeriodEnd: v.cancelAtPeriodEnd === true,
    cancelAt: date(v.cancelAt),
    graceUntil: date(v.graceUntil),
    startedAt: date(v.startedAt),
  };
}

function parsePaymentMethod(v: unknown): HostedBillingPaymentMethod | null {
  if (!isObj(v) || typeof v.brand !== 'string') return null;
  return {
    brand: v.brand,
    last4: typeof v.last4 === 'string' ? v.last4 : '',
    expMonth: num(v.expMonth),
    expYear: num(v.expYear),
    isDefault: v.isDefault === true,
  };
}

function parsePayment(v: unknown): HostedBillingPayment | null {
  if (!isObj(v)) return null;
  const amountCents = num(v.amountCents);
  const paidAt = date(v.paidAt);
  if (amountCents === null || paidAt === null || typeof v.currency !== 'string') return null;
  return {
    // Used as a list key: the fallback must not collide for two payments at
    // the same instant.
    id: typeof v.id === 'string' ? v.id : `${paidAt}:${amountCents}:${num(v.taxCents) ?? 0}`,
    amountCents,
    taxCents: num(v.taxCents) ?? 0,
    currency: v.currency,
    paidAt,
    invoiceNumber: typeof v.invoiceNumber === 'string' ? v.invoiceNumber : null,
    invoiceUrl: httpsOrNull(v.invoiceUrl),
    invoicePdfUrl: httpsOrNull(v.invoicePdfUrl),
  };
}

function parseUpcoming(v: unknown): HostedBillingUpcomingInvoice | null {
  if (!isObj(v)) return null;
  const amountDueCents = num(v.amountDueCents);
  if (amountDueCents === null || typeof v.currency !== 'string') return null;
  return { amountDueCents, currency: v.currency, date: date(v.date) };
}

const compact = <T>(items: unknown, parse: (v: unknown) => T | null): T[] =>
  Array.isArray(items) ? items.map(parse).filter((x): x is T => x !== null) : [];

export function parseHostedBillingSummary(raw: unknown): HostedBillingSummary | null {
  if (!isObj(raw) || !Array.isArray(raw.plans) || !Array.isArray(raw.payments)) return null;
  // Absent reads like null ("none" / "unavailable"), in the same spirit as the
  // optional later fields; only a PRESENT value of the wrong type is fatal.
  if (raw.subscription != null && !isObj(raw.subscription)) return null;
  if (raw.paymentMethods != null && !Array.isArray(raw.paymentMethods)) return null;
  return {
    account: { email: isObj(raw.account) && typeof raw.account.email === 'string' ? raw.account.email : '' },
    subscription: parseSubscription(raw.subscription),
    plans: compact(raw.plans, parsePlan),
    upcomingInvoice: parseUpcoming(raw.upcomingInvoice),
    paymentMethods: raw.paymentMethods == null ? null : compact(raw.paymentMethods, parsePaymentMethod),
    payments: compact(raw.payments, parsePayment),
  };
}

// ── Reader ──────────────────────────────────────────────────────────────────

/** Slower than the usage meter's: this one waits on a live card-processor call. */
const TIMEOUT_MS = 8_000;

/**
 * How long a reading is reused. Matches the control plane's own per-user cache:
 * polling faster buys nothing but load. The shell's banner and the Billing tab
 * read through this, so they share one request.
 */
export const BILLING_CACHE_MS = 60_000;

/**
 * A FRESH read (the user came back from changing something in the browser, or
 * pressed refresh) still reuses anything younger than this, so a focus event
 * storm is not a request storm.
 */
export const BILLING_FRESH_MIN_MS = 5_000;

export interface HostedBillingReaderDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Config per call, not captured: the system block is re-read on SIGHUP so a key
 * can rotate without a restart, and the cache key includes the credentials so a
 * rotation invalidates the reading.
 */
export function makeHostedBillingReader(
  deps: HostedBillingReaderDeps = {},
): (config: JarvisConfig, opts?: { fresh?: boolean }) => Promise<HostedBillingSummary | null> {
  const callFetch = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> =>
    (deps.fetchImpl ?? fetch)(...args);
  const now = deps.now ?? (() => Date.now());
  let cache: { key: string; at: number; value: HostedBillingSummary | null } | null = null;
  let inflight: { key: string; promise: Promise<HostedBillingSummary | null> } | null = null;
  /** The credentials of the most recent call: the key a reading is "current" for. */
  let latestKey = '';

  const fetchSummary = async (cfg: HostedBillingConfig): Promise<HostedBillingSummary | null> => {
    const body = JSON.stringify({ instanceId: cfg.instanceId, at: new Date(now()).toISOString() });
    try {
      const res = await callFetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INSTANCE_SIGNATURE_HEADER]: signWithSecret(cfg.secret, body),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const summary = parseHostedBillingSummary(await res.json().catch(() => null));
        if (!summary) console.warn('[billing] control plane returned an unrecognised summary shape; billing unavailable');
        return summary;
      }
      if (res.status === 400) {
        // The one body worth keeping: a >5min clock drift fails every read, and
        // the control plane says so here. Redacted and bounded.
        const detail = redactSecrets(await res.text().catch(() => '')).slice(0, 300);
        console.warn(`[billing] control plane rejected the request: ${detail || '(no detail)'}`);
      } else {
        // STATUS only: a body could name the control-plane host or echo what we sent.
        console.warn(`[billing] control plane answered ${res.status}; billing unavailable`);
      }
    } catch (err) {
      console.warn(
        '[billing] could not reach the control plane; billing unavailable:',
        redactSecrets(err instanceof Error ? err.message : String(err)),
      );
    }
    return null;
  };

  return async (config, opts) => {
    const cfg = readHostedBillingConfig(config);
    if (!cfg) return null;
    const key = `${cfg.url}|${cfg.instanceId}|${cfg.secret}`;
    latestKey = key;
    if (cache && cache.key === key) {
      const age = now() - cache.at;
      if (age < (opts?.fresh ? BILLING_FRESH_MIN_MS : BILLING_CACHE_MS)) return cache.value;
    }
    // Concurrent callers (the banner and the tab mounting together) share one
    // request rather than racing two signed reads.
    if (inflight && inflight.key === key) return inflight.promise;
    const promise = fetchSummary(cfg).then((value) => {
      // A failure is cached too: an unreachable control plane must not become a
      // request per render. But a request signed with a key rotated away while
      // it was in flight must not overwrite a reading already taken under the
      // NEWER key — that would only cost the next caller another request.
      if (key === latestKey || cache?.key !== latestKey) {
        cache = { key, at: now(), value };
      }
      return value;
    });
    inflight = { key, promise };
    try {
      return await promise;
    } finally {
      if (inflight?.promise === promise) inflight = null;
    }
  };
}

/** The daemon's one reader: a singleton because the CACHE is the point. */
const shared = makeHostedBillingReader();

export function readHostedBilling(
  config: JarvisConfig,
  opts?: { fresh?: boolean },
): Promise<HostedBillingSummary | null> {
  return shared(config, opts);
}
