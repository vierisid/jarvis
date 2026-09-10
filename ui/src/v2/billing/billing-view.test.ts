import { describe, expect, test } from 'bun:test';
import {
  bannerFor,
  billingState,
  billingTabVisible,
  boldSegments,
  brandLabel,
  cardExpiresBefore,
  chargedCard,
  classifyBillingResponse,
  endsAt,
  formatExpiry,
  formatMoney,
  isHttpsUrl,
  needsAttention,
  nextChargeDate,
  paymentRow,
  planMeta,
  planTitle,
  recurringTotal,
  type BillingPaymentMethod,
  type BillingSubscription,
  type BillingSummary,
} from './billing-view.ts';

const LINKS = {
  page: 'https://app.example/billing',
  manage: 'https://app.example/billing?action=manage',
  paymentMethod: 'https://app.example/billing?action=payment-method',
  changePlan: 'https://app.example/billing?action=change-plan',
  cancel: 'https://app.example/billing?action=cancel',
};

/** Mid-period: after the start, before the end and before every grace/cancel date below. */
const NOW = Date.parse('2026-09-10T12:00:00.000Z');

const sub = (over: Partial<BillingSubscription> = {}): BillingSubscription => ({
  status: 'active',
  currentPeriodStart: '2026-09-01T00:00:00.000Z',
  currentPeriodEnd: '2026-10-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  cancelAt: null,
  graceUntil: null,
  startedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

const card = (over: Partial<BillingPaymentMethod> = {}): BillingPaymentMethod => ({
  brand: 'visa',
  last4: '4242',
  expMonth: 8,
  expYear: 2027,
  isDefault: true,
  ...over,
});

const summary = (over: Partial<BillingSummary> = {}): BillingSummary => ({
  account: { email: 'o@example.com' },
  subscription: sub(),
  plans: [{ key: 'base', name: 'Base', quantity: 1, prices: [{ interval: 'month', unitAmount: 999, currency: 'usd' }] }],
  upcomingInvoice: null,
  paymentMethods: [card()],
  payments: [],
  ...over,
});

describe('classifying GET /api/billing', () => {
  test("only the DAEMON's 503 means self-hosted; a failed fetch is unknown, never \"no bill\"", () => {
    expect(classifyBillingResponse(503, { error: 'Billing is only available on hosted installs.' })).toEqual({ kind: 'self' });
    // A bare 503 from a proxy in between must not end polling for a hosted user.
    expect(classifyBillingResponse(503, null)).toEqual({ kind: 'failed' });
    expect(classifyBillingResponse(503, { message: 'upstream' })).toEqual({ kind: 'failed' });
    expect(classifyBillingResponse(500, null)).toEqual({ kind: 'failed' });
    expect(classifyBillingResponse(404, null)).toEqual({ kind: 'failed' });
    expect(classifyBillingResponse(200, null)).toEqual({ kind: 'failed' });
    expect(classifyBillingResponse(200, { hello: 1 })).toEqual({ kind: 'failed' });
  });

  test('ready needs both a summary and well-formed links', () => {
    expect(classifyBillingResponse(200, { ok: true, summary: summary(), links: LINKS }).kind).toBe('ready');
    expect(classifyBillingResponse(200, { ok: true, summary: summary(), links: null }).kind).toBe('failed');
  });

  test('a link that is not http(s) is never treated as a link', () => {
    const evil = { ...LINKS, cancel: 'javascript:alert(1)' };
    expect(classifyBillingResponse(200, { ok: true, summary: summary(), links: evil }).kind).toBe('failed');
    expect(classifyBillingResponse(200, { ok: false, links: evil })).toEqual({ kind: 'unavailable', links: null });
    expect(isHttpsUrl('https://invoice.stripe.com/i/x')).toBe(true);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('http://x')).toBe(false);
    expect(isHttpsUrl(null)).toBe(false);
  });

  test('unavailable keeps the links so the user still has a way to their account', () => {
    expect(classifyBillingResponse(200, { ok: false, error: 'x', links: LINKS })).toEqual({ kind: 'unavailable', links: LINKS });
    expect(classifyBillingResponse(200, { ok: false, error: 'x', links: null })).toEqual({ kind: 'unavailable', links: null });
  });
});

describe('the Settings tab', () => {
  test('is hidden only when the daemon has said the install is self-hosted', () => {
    expect(billingTabVisible('self')).toBe(false);
    expect(billingTabVisible('ready')).toBe(true);
    // Hosted but not connected still has somewhere to point the user.
    expect(billingTabVisible('unavailable')).toBe(true);
    // Not known yet (or the read is failing): never hide a hosted user's page.
    expect(billingTabVisible('unknown')).toBe(true);
  });
});

describe('state', () => {
  test('maps processor statuses onto the design lifecycle', () => {
    expect(billingState(null)).toBe('none');
    expect(billingState(sub())).toBe('active');
    expect(billingState(sub({ status: 'trialing' }))).toBe('active');
    expect(billingState(sub({ cancelAtPeriodEnd: true }))).toBe('canceling');
    expect(billingState(sub({ cancelAt: '2026-10-01T00:00:00.000Z' }))).toBe('canceling');
    expect(billingState(sub({ status: 'past_due' }))).toBe('past_due');
    expect(billingState(sub({ status: 'unpaid' }))).toBe('past_due');
    expect(billingState(sub({ status: 'incomplete' }))).toBe('incomplete');
    expect(billingState(sub({ status: 'canceled' }))).toBe('none');
  });

  test('a scheduled cancel ends at cancelAt when Stripe states one, else the period end', () => {
    expect(endsAt(sub({ cancelAt: '2026-09-20T00:00:00.000Z' }))).toBe('2026-09-20T00:00:00.000Z');
    expect(endsAt(sub())).toBe('2026-10-01T00:00:00.000Z');
  });

  test('active is quiet: no banner', () => {
    expect(bannerFor(summary(), NOW)).toBeNull();
    expect(bannerFor(summary({ subscription: null }), NOW)).toBeNull();
  });

  test('past due asks for a card and names the grace date while it is ahead', () => {
    const b = bannerFor(summary({ subscription: sub({ status: 'past_due', graceUntil: '2026-09-17T00:00:00.000Z' }) }), NOW)!;
    expect(b.tone).toBe('warn');
    expect(b.action.link).toBe('paymentMethod');
    expect(b.message).toContain('stays online until');
  });

  test('a grace window or cancel date already behind now is never promised', () => {
    const lapsed = summary({ subscription: sub({ status: 'past_due', graceUntil: '2026-09-05T00:00:00.000Z' }) });
    expect(bannerFor(lapsed, NOW)!.message).not.toContain('until');
    expect(planMeta(lapsed, NOW)).not.toContain('until');
    const ended = summary({ subscription: sub({ cancelAtPeriodEnd: true, cancelAt: '2026-09-09T00:00:00.000Z' }) });
    expect(bannerFor(ended, NOW)!.message).not.toContain('until');
    expect(planMeta(ended, NOW)).not.toContain('Ends **');
  });

  test('a scheduled cancel is neutral (a choice, not a fault) and offers resume', () => {
    const b = bannerFor(summary({ subscription: sub({ cancelAtPeriodEnd: true }) }), NOW)!;
    expect(b.tone).toBe('neutral');
    expect(b.action.link).toBe('manage');
    expect(b.message).toContain('access until');
  });

  test('an incomplete first payment speaks up', () => {
    const b = bannerFor(summary({ subscription: sub({ status: 'incomplete' }) }), NOW)!;
    expect(b.tone).toBe('warn');
    expect(b.action.link).toBe('manage');
  });

  test('the plan line says what happens next', () => {
    expect(planMeta(summary(), NOW)).toContain('Renews');
    expect(planMeta(summary(), NOW)).toContain('Visa •••• 4242');
    expect(
      planMeta(summary({ upcomingInvoice: { amountDueCents: 1299, currency: 'usd', date: '2026-10-01T00:00:00.000Z' } }), NOW),
    ).toContain('Next charge');
    // A preview without a date falls back to the renewal date, never "on null".
    const undated = planMeta(summary({ upcomingInvoice: { amountDueCents: 1299, currency: 'usd', date: null } }), NOW);
    expect(undated).toContain('Renews');
    expect(undated).not.toContain('null');
    expect(planMeta(summary({ subscription: sub({ cancelAtPeriodEnd: true }) }), NOW)).toContain('Ends');
    expect(planMeta(summary({ subscription: sub({ status: 'past_due', graceUntil: null }) }), NOW)).toContain('Payment failed');
    expect(planMeta(summary({ subscription: null }), NOW)).toContain("don't have a subscription");
  });
});

describe('the charged card and attention', () => {
  test('the charged card is the default, or the only card; otherwise nobody claims to know', () => {
    const backup = card({ brand: 'mastercard', last4: '5454', isDefault: false });
    expect(chargedCard(summary({ paymentMethods: [backup, card()] }))?.last4).toBe('4242');
    expect(chargedCard(summary({ paymentMethods: [card({ isDefault: false })] }))?.last4).toBe('4242');
    expect(chargedCard(summary({ paymentMethods: [card({ isDefault: false }), backup] }))).toBeNull();
    expect(chargedCard(summary({ paymentMethods: null }))).toBeNull();
    // With no known card the plan line names none.
    expect(planMeta(summary({ paymentMethods: [card({ isDefault: false }), backup] }), NOW)).not.toContain('••••');
  });

  test('"All good" is withheld when the next charge has nowhere good to go', () => {
    expect(needsAttention(summary())).toBe(false);
    expect(needsAttention(summary({ paymentMethods: [] }))).toBe(true);
    expect(needsAttention(summary({ paymentMethods: null }))).toBe(true);
    // The charged card expires before the renewal on Oct 1.
    expect(needsAttention(summary({ paymentMethods: [card({ expMonth: 9, expYear: 2026 })] }))).toBe(true);
    // A BACKUP card expiring is not the charge's problem.
    expect(
      needsAttention(summary({ paymentMethods: [card(), card({ last4: '1111', expMonth: 9, expYear: 2026, isDefault: false })] })),
    ).toBe(false);
    // Only an active, renewing plan has a next charge to worry about.
    expect(needsAttention(summary({ subscription: sub({ cancelAtPeriodEnd: true }), paymentMethods: [] }))).toBe(false);
  });

  test('the next charge is the preview date, else the renewal of an active plan', () => {
    expect(nextChargeDate(summary())).toBe('2026-10-01T00:00:00.000Z');
    expect(
      nextChargeDate(summary({ upcomingInvoice: { amountDueCents: 1, currency: 'usd', date: '2026-09-30T00:00:00.000Z' } })),
    ).toBe('2026-09-30T00:00:00.000Z');
    expect(nextChargeDate(summary({ subscription: sub({ cancelAtPeriodEnd: true }) }))).toBeNull();
  });
});

describe('money and cards', () => {
  test('money is formatted in the processor currency and its own exponent; an unknown code does not throw', () => {
    expect(formatMoney(999, 'usd')).toContain('9.99');
    expect(formatMoney(999, 'eur')).toContain('9.99');
    // Zero-decimal: 500 JPY is ¥500, not ¥5.
    expect(formatMoney(500, 'jpy')).toContain('500');
    expect(formatMoney(999, 'not-a-currency')).toBe('9.99 NOT-A-CURRENCY');
  });

  test('a single recurring total only when every plan shares currency and interval', () => {
    const base = { key: 'b', name: 'Base', quantity: 1, prices: [{ interval: 'month', unitAmount: 999, currency: 'usd' }] };
    const disk = { key: 'd', name: 'Disk', quantity: 2, prices: [{ interval: 'month', unitAmount: 300, currency: 'usd' }] };
    expect(recurringTotal([base, disk])).toEqual({ interval: 'month', unitAmount: 1599, currency: 'usd' });
    expect(recurringTotal([base, { ...disk, prices: [{ interval: 'month', unitAmount: 300, currency: 'eur' }] }])).toBeNull();
    expect(recurringTotal([base, { ...disk, prices: [] }])).toBeNull();
    expect(recurringTotal([])).toBeNull();
    expect(planTitle([base, disk])).toBe('Base + Disk × 2');
    expect(planTitle([])).toBe('No active plan');
  });

  test('expiry is the END of the stated month', () => {
    expect(formatExpiry(card())).toBe('08 / 27');
    expect(formatExpiry(card({ expMonth: null }))).toBeNull();
    // Expires Aug 2027: still valid on Aug 31, gone on Sep 1.
    expect(cardExpiresBefore(card(), '2027-08-31T23:00:00.000Z')).toBe(false);
    expect(cardExpiresBefore(card(), '2027-09-01T00:00:00.000Z')).toBe(true);
    expect(cardExpiresBefore(card({ expMonth: 12, expYear: 2027 }), '2028-01-01T00:00:00.000Z')).toBe(true);
    expect(cardExpiresBefore(card(), null)).toBe(false);
  });

  test('brands read like words', () => {
    expect(brandLabel('visa')).toBe('Visa');
    expect(brandLabel('amex')).toBe('American Express');
    expect(brandLabel('sepa_debit')).toBe('Sepa debit');
    expect(brandLabel('')).toBe('Card');
  });

  test('a payment shows gross with its tax; a refund reads as a refund', () => {
    const p = { id: '1', amountCents: 833, taxCents: 166, currency: 'usd', paidAt: '2026-09-01T00:00:00.000Z', invoiceNumber: null, invoiceUrl: null, invoicePdfUrl: null };
    const row = paymentRow(p);
    expect(row.amount).toContain('9.99');
    expect(row.tax).toContain('1.66');
    expect(row.label).toBe('Payment');
    expect(paymentRow({ ...p, invoiceNumber: 'AB-1' }).label).toBe('Invoice AB-1');
    const refund = paymentRow({ ...p, amountCents: -833, taxCents: -166 });
    expect(refund.refund).toBe(true);
    expect(refund.label).toBe('Refund');
    expect(refund.tax).toBeNull();
  });

  test('bold markers split into segments', () => {
    expect(boldSegments('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ]);
  });
});
