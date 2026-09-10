import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { JarvisConfig } from '../config/types.ts';
import {
  BILLING_CACHE_MS,
  BILLING_FRESH_MIN_MS,
  billingLinks,
  makeHostedBillingReader,
  parseHostedBillingSummary,
  readHostedBillingConfig,
} from './hosted-billing.ts';

const SECRET = 'a'.repeat(64);
const configWith = (over: Record<string, unknown> = {}): JarvisConfig =>
  ({
    usejarvis_billing: {
      url: 'https://cp.example/api/billing/instance',
      instance_id: 'inst-1',
      secret: SECRET,
      page_url: 'https://app.example/billing',
      ...over,
    },
  }) as unknown as JarvisConfig;

/** What the control plane answers today (no later-added fields). */
const SUMMARY = {
  account: { email: 'owner@example.com' },
  subscription: { status: 'active', currentPeriodEnd: '2026-10-01T00:00:00.000Z', graceUntil: null },
  plans: [
    {
      key: 'base',
      name: 'Base',
      quantity: 1,
      prices: [{ interval: 'month', unitAmount: 999, currency: 'usd' }],
    },
  ],
  paymentMethods: [{ brand: 'visa', last4: '4242', expMonth: 8, expYear: 2027 }],
  payments: [
    { id: 'p1', amountCents: 833, taxCents: 166, currency: 'usd', paidAt: '2026-09-01T00:00:00.000Z' },
  ],
};

function stubFetch(reply: () => Response) {
  const calls: Array<{ url: string; body: string; signature: string | null }> = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: String(init?.body ?? ''),
      signature: new Headers(init?.headers).get('x-jarvis-signature'),
    });
    return reply();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = () => new Response(JSON.stringify(SUMMARY), { status: 200 });

describe('hosted billing config', () => {
  test('all four fields or billing is OFF', () => {
    expect(readHostedBillingConfig(configWith())).toEqual({
      url: 'https://cp.example/api/billing/instance',
      instanceId: 'inst-1',
      secret: SECRET,
      pageUrl: 'https://app.example/billing',
    });
    for (const key of ['url', 'instance_id', 'secret', 'page_url']) {
      expect(readHostedBillingConfig(configWith({ [key]: '  ' }))).toBeNull();
      expect(readHostedBillingConfig(configWith({ [key]: undefined }))).toBeNull();
    }
    expect(readHostedBillingConfig({} as JarvisConfig)).toBeNull();
    // An unquoted scalar that YAML parsed as a number is not a string.
    expect(readHostedBillingConfig(configWith({ secret: 1234 }))).toBeNull();
  });

  test('the page becomes a clickable link, so only http(s) may pass; the endpoint is https only', () => {
    expect(readHostedBillingConfig(configWith({ page_url: 'javascript:alert(1)' }))).toBeNull();
    expect(readHostedBillingConfig(configWith({ page_url: 'http://localhost:3000/billing' }))).not.toBeNull();
    expect(readHostedBillingConfig(configWith({ url: 'http://cp.example/api/billing/instance' }))).toBeNull();
  });

  test('links carry the action on the account page, keeping its own query', () => {
    const links = billingLinks('https://app.example/billing?ref=brain');
    expect(links.page).toBe('https://app.example/billing?ref=brain');
    expect(new URL(links.cancel).searchParams.get('action')).toBe('cancel');
    expect(new URL(links.cancel).searchParams.get('ref')).toBe('brain');
    expect(new URL(links.paymentMethod).searchParams.get('action')).toBe('payment-method');
    expect(new URL(links.changePlan).searchParams.get('action')).toBe('change-plan');
    expect(new URL(links.manage).searchParams.get('action')).toBe('manage');
  });
});

describe('billing summary parsing', () => {
  test("today's control-plane shape parses, with later fields defaulted rather than undefined", () => {
    const s = parseHostedBillingSummary(SUMMARY)!;
    expect(s.account.email).toBe('owner@example.com');
    expect(s.subscription).toEqual({
      status: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: '2026-10-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      cancelAt: null,
      graceUntil: null,
      startedAt: null,
    });
    expect(s.upcomingInvoice).toBeNull();
    expect(s.paymentMethods).toEqual([{ brand: 'visa', last4: '4242', expMonth: 8, expYear: 2027, isDefault: false }]);
    expect(s.payments[0]).toMatchObject({ invoiceNumber: null, invoiceUrl: null, invoicePdfUrl: null });
  });

  test('the later-added details parse when present', () => {
    const s = parseHostedBillingSummary({
      ...SUMMARY,
      subscription: { ...SUMMARY.subscription, cancelAtPeriodEnd: true, cancelAt: '2026-10-01T00:00:00.000Z' },
      upcomingInvoice: { amountDueCents: 999, currency: 'usd', date: '2026-10-01T00:00:00.000Z' },
      paymentMethods: [{ ...SUMMARY.paymentMethods[0], isDefault: true }],
      payments: [
        {
          ...SUMMARY.payments[0],
          invoiceNumber: 'ABC-0001',
          invoiceUrl: 'https://invoice.stripe.com/i/x',
          invoicePdfUrl: 'https://pay.stripe.com/invoice/x/pdf',
        },
      ],
    })!;
    expect(s.subscription?.cancelAtPeriodEnd).toBe(true);
    expect(s.upcomingInvoice).toEqual({ amountDueCents: 999, currency: 'usd', date: '2026-10-01T00:00:00.000Z' });
    expect(s.paymentMethods?.[0]?.isDefault).toBe(true);
    expect(s.payments[0]?.invoiceUrl).toBe('https://invoice.stripe.com/i/x');
  });

  test('an invoice link that is not https is dropped, never rendered as a link', () => {
    const s = parseHostedBillingSummary({
      ...SUMMARY,
      payments: [{ ...SUMMARY.payments[0], invoiceUrl: 'javascript:alert(1)', invoicePdfUrl: 'http://x/pdf' }],
    })!;
    expect(s.payments[0]?.invoiceUrl).toBeNull();
    expect(s.payments[0]?.invoicePdfUrl).toBeNull();
  });

  test('null payment methods stay NULL (unavailable), not an empty list (none saved)', () => {
    expect(parseHostedBillingSummary({ ...SUMMARY, paymentMethods: null })?.paymentMethods).toBeNull();
    // Absent reads like null rather than blanking the whole page.
    const { paymentMethods: _pm, subscription: _sub, ...bare } = SUMMARY;
    const parsed = parseHostedBillingSummary(bare);
    expect(parsed?.paymentMethods).toBeNull();
    expect(parsed?.subscription).toBeNull();
    expect(parseHostedBillingSummary({ ...SUMMARY, paymentMethods: [] })?.paymentMethods).toEqual([]);
  });

  test('a shape missing what every section needs is unavailable as a whole', () => {
    expect(parseHostedBillingSummary(null)).toBeNull();
    expect(parseHostedBillingSummary({ hello: 'world' })).toBeNull();
    expect(parseHostedBillingSummary({ ...SUMMARY, plans: 'x' })).toBeNull();
    expect(parseHostedBillingSummary({ ...SUMMARY, subscription: 'active' })).toBeNull();
    expect(parseHostedBillingSummary({ ...SUMMARY, paymentMethods: {} })).toBeNull();
  });

  test('malformed items are dropped instead of rendering undefineds', () => {
    const s = parseHostedBillingSummary({
      ...SUMMARY,
      plans: [...SUMMARY.plans, { key: 'x' }, 7],
      payments: [...SUMMARY.payments, { amountCents: 'lots', currency: 'usd', paidAt: 'x' }],
    })!;
    expect(s.plans).toHaveLength(1);
    expect(s.payments).toHaveLength(1);
  });
});

describe('hosted billing reader', () => {
  test('signs the EXACT bytes it sends, with the billing secret', async () => {
    const { fn, calls } = stubFetch(ok);
    const read = makeHostedBillingReader({ fetchImpl: fn, now: () => 1_000 });
    expect((await read(configWith()))?.plans[0]?.name).toBe('Base');
    const call = calls[0]!;
    expect(call.url).toBe('https://cp.example/api/billing/instance');
    expect(call.signature).toBe(createHmac('sha256', SECRET).update(call.body).digest('hex'));
    expect(JSON.parse(call.body)).toEqual({ instanceId: 'inst-1', at: new Date(1_000).toISOString() });
  });

  test('one request per cache window; fresh re-reads, but not faster than the floor', async () => {
    let clock = 0;
    const { fn, calls } = stubFetch(ok);
    const read = makeHostedBillingReader({ fetchImpl: fn, now: () => clock });
    await read(configWith());
    await read(configWith());
    expect(calls).toHaveLength(1);
    // A focus storm right after a read still shares it.
    clock = BILLING_FRESH_MIN_MS - 1;
    await read(configWith(), { fresh: true });
    expect(calls).toHaveLength(1);
    clock = BILLING_FRESH_MIN_MS + 1;
    await read(configWith(), { fresh: true });
    expect(calls).toHaveLength(2);
    clock += BILLING_CACHE_MS - 1;
    await read(configWith());
    expect(calls).toHaveLength(2);
    clock += 2;
    await read(configWith());
    expect(calls).toHaveLength(3);
  });

  test('concurrent callers share ONE in-flight request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let count = 0;
    const fn = (async () => {
      count++;
      await gate;
      return ok();
    }) as unknown as typeof fetch;
    const read = makeHostedBillingReader({ fetchImpl: fn, now: () => 0 });
    const a = read(configWith());
    const b = read(configWith());
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(count).toBe(1);
    expect(ra).toEqual(rb);
  });

  test('a request signed before a rotation cannot overwrite the reading taken after it', async () => {
    let clock = 0;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((r) => (releaseOld = r));
    const calls: string[] = [];
    const fn = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const sig = new Headers(init?.headers).get('x-jarvis-signature') ?? '';
      const isOld = sig === createHmac('sha256', SECRET).update(String(init?.body)).digest('hex');
      calls.push(isOld ? 'old' : 'new');
      if (isOld) await oldGate;
      return ok();
    }) as unknown as typeof fetch;
    const read = makeHostedBillingReader({ fetchImpl: fn, now: () => clock });
    const rotated = configWith({ secret: 'b'.repeat(64) });

    const oldRead = read(configWith());
    clock = 10;
    await read(rotated); // finishes first, caches under the new key
    releaseOld();
    await oldRead;
    clock = 20;
    await read(rotated);
    // The third read reused the new-key reading instead of refetching.
    expect(calls).toEqual(['old', 'new']);
  });

  test('a ROTATED secret invalidates the cache instead of serving a reading from the old key', async () => {
    const { fn, calls } = stubFetch(ok);
    const read = makeHostedBillingReader({ fetchImpl: fn, now: () => 0 });
    await read(configWith());
    await read(configWith({ secret: 'b'.repeat(64) }));
    expect(calls).toHaveLength(2);
  });

  test('failures read as null, are cached, and never throw at the caller', async () => {
    let clock = 0;
    const { fn, calls } = stubFetch(() => new Response('nope', { status: 502 }));
    const read = makeHostedBillingReader({ fetchImpl: fn, now: () => clock });
    expect(await read(configWith())).toBeNull();
    clock = BILLING_CACHE_MS - 1;
    expect(await read(configWith())).toBeNull();
    expect(calls).toHaveLength(1);

    const boom = (async () => {
      throw new Error('connect ECONNREFUSED https://cp.example');
    }) as unknown as typeof fetch;
    expect(await makeHostedBillingReader({ fetchImpl: boom, now: () => 0 })(configWith())).toBeNull();

    const garbage = stubFetch(() => new Response('<html>', { status: 200 }));
    expect(await makeHostedBillingReader({ fetchImpl: garbage.fn, now: () => 0 })(configWith())).toBeNull();
  });

  test('no billing block means no request at all', async () => {
    const { fn, calls } = stubFetch(ok);
    expect(await makeHostedBillingReader({ fetchImpl: fn })({} as JarvisConfig)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
