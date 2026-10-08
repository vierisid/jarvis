import { beforeEach, describe, expect, test } from 'bun:test';
import { WebSocketService, shownApprovalIdFrom, voiceApprovalAmbiguous, voiceApprovalGatedMessage } from './ws-service.ts';
import { getDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager, type ApprovalRequest } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor } from '../authority/deferred-executor.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * #809. A spoken "yes" used to approve whatever approval was newest when the
 * transcript arrived, and to name it by the engine's reason. It now decides
 * only the approval the dashboard showed when the person started speaking,
 * and says so when that is not the newest one.
 */

type Sent = { type?: string; payload?: Record<string, unknown> };

/**
 * An assistant message as the thread renders it: markdown, with GFM, the way
 * `MarkdownBody` does. The replies quote model-written text, so what is
 * asserted is what the person reads, not the escaped source.
 */
function html(markdown: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown));
}
function shown(markdown: string): string {
  return html(markdown).replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

let mgr: ApprovalManager;
let executions: string[];
let sent: Sent[];
let svc: WebSocketService;

/** A classifier reply that reads the utterance as a plain "yes" or "no". */
const classified = (decision: 'approve' | 'cancel') =>
  JSON.stringify({ verb: 'unknown', object: null, args: {}, impact: 'read', confidence: 0.96, confirmation_response: decision });

let classifierReply = classified('approve');

beforeEach(() => {
  initDatabase(':memory:');
  mgr = new ApprovalManager();
  const executor = new DeferredExecutor(mgr, new AuditTrail());
  executions = [];
  executor.setToolRegistry({
    get: () => undefined,
    execute: async (name: string, args: Record<string, unknown>) => { executions.push(`${name}:${String(args.to)}`); return 'sent'; },
  } as unknown as ToolRegistry);
  classifierReply = classified('approve');
  const fakeAgent = {
    setDelegationCallback: () => {},
    // Past first-run setup, or every utterance is answered with "finish setup".
    getConfig: () => ({ onboarding: { setup_completed_at: 1 } }),
    getLLMManager: () => ({ chatTier: async () => ({ content: classifierReply }) }),
  } as never;
  svc = new WebSocketService(0, fakeAgent);
  svc.setApprovalManager(mgr);
  svc.setDeferredExecutor(executor);
  sent = [];
  const server = (svc as unknown as { wsServer: { broadcast: (m: Sent) => void; sendToClient: (ws: unknown, m: Sent) => void } }).wsServer;
  server.broadcast = (m) => { sent.push(m); };
  server.sendToClient = (_ws, m) => { sent.push(m); };
});

/** A pending send_email (external, so voice may resolve it) to `to`, created at `at`. */
function pendingEmail(to: string, at: number): ApprovalRequest {
  const req = mgr.createRequest({
    agentId: 'a1', agentName: 'PA', toolName: 'send_email', toolArguments: { to, subject: 'Q3' },
    actionCategory: 'send_email', urgency: 'normal', reason: 'send_email requires user approval', context: '',
  });
  getDb().run('UPDATE approval_requests SET created_at = ? WHERE id = ?', [at, req.id]);
  return mgr.getRequest(req.id)!;
}

const status = (req: ApprovalRequest) => mgr.getRequest(req.id)!.status;
const replies = () => sent
  .filter((m) => m.payload?.source === 'assistant_message')
  .map((m) => String(m.payload!.text));

describe('#809: resolveLatestPendingByVoice decides only the approval that was on screen', () => {
  test('the approval shown is the newest: it is approved, and named by what it does', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, a.id);
    expect(resolved?.kind).toBe('approval');
    expect(shown((resolved as { label: string }).label)).toBe('Send email to alice@example.com — "Q3"');
    expect(status(a)).toBe('executed');
    expect(executions).toEqual(['send_email:alice@example.com']);
  });

  test('a request arriving while the person answers is not approved, and neither is theirs', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const b = pendingEmail('mallory@example.com', 2000);
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, a.id);
    expect(resolved?.kind).toBe('refused');
    if (resolved?.kind !== 'refused') throw new Error('unreachable');
    expect(resolved.message).toContain('A new request arrived while you were answering');
    expect(resolved.message).toContain("I haven't approved anything");
    // Names the one they were answering, still waiting, and the new one.
    expect(shown(resolved.message)).toContain('still waiting: Send email to alice@example.com');
    expect(shown(resolved.message)).toContain('The new one: Send email to mallory@example.com');
    // Never "say yes again": the new one is on top now, so a second yes answers it.
    expect(resolved.message.toLowerCase()).not.toContain('again');
    expect(status(a)).toBe('pending');
    expect(status(b)).toBe('pending');
    expect(executions).toEqual([]);
  });

  test('a no is held to the same rule: nothing is cancelled', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const b = pendingEmail('mallory@example.com', 2000);
    const resolved = await svc.resolveLatestPendingByVoice('cancel', 1, a.id);
    expect(resolved?.kind).toBe('refused');
    if (resolved?.kind !== 'refused') throw new Error('unreachable');
    expect(resolved.message).toContain("I haven't cancelled anything");
    expect(status(a)).toBe('pending');
    expect(status(b)).toBe('pending');
  });

  test('nothing on screen when they started: the request that arrived meanwhile is not approved', async () => {
    const b = pendingEmail('mallory@example.com', 2000);
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, null);
    expect(resolved?.kind).toBe('refused');
    if (resolved?.kind !== 'refused') throw new Error('unreachable');
    expect(resolved.message).toContain('No approval was on your screen when you started speaking');
    expect(shown(resolved.message)).toContain('Waiting for you: Send email to mallory@example.com');
    expect(status(b)).toBe('pending');
  });

  test('a client that does not say what it showed decides nothing', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1);
    expect(resolved?.kind).toBe('refused');
    if (resolved?.kind !== 'refused') throw new Error('unreachable');
    expect(resolved.message).toContain("I couldn't tell which request was on your screen");
    expect(status(a)).toBe('pending');
  });

  test('theirs was decided elsewhere and another is waiting: the other is not approved', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const b = pendingEmail('mallory@example.com', 2000);
    mgr.deny(a.id, 'dashboard');
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, a.id);
    expect(resolved?.kind).toBe('refused');
    if (resolved?.kind !== 'refused') throw new Error('unreachable');
    expect(resolved.message).toContain('already been decided or has expired');
    expect(shown(resolved.message)).toContain('Another one is waiting: Send email to mallory@example.com');
    expect(status(b)).toBe('pending');
  });

  test('theirs was decided elsewhere and nothing else is pending: a held clarifier is not confirmed', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    mgr.deny(a.id, 'dashboard');
    const confirmations = (svc as unknown as { pendingVoiceConfirmations: Map<string, unknown> }).pendingVoiceConfirmations;
    confirmations.set('c1', { id: 'c1', transcript: 'delete my notes', kind: 'repeat_back', createdAt: 1, ws: {} });
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, a.id);
    expect(resolved?.kind).toBe('refused');
    expect(confirmations.has('c1')).toBe(true);
  });

  test('with no approval involved, a clarifier still resolves as before', async () => {
    const confirmations = (svc as unknown as { pendingVoiceConfirmations: Map<string, unknown> }).pendingVoiceConfirmations;
    confirmations.set('c1', { id: 'c1', transcript: 'what is the weather', kind: 'repeat_back', createdAt: 1, ws: {} });
    (svc as unknown as { handleChat: () => Promise<void> }).handleChat = async () => {};
    const resolved = await svc.resolveLatestPendingByVoice('cancel', 1, null);
    expect(resolved).toEqual({ kind: 'repeat_back', label: 'what is the weather' });
    expect(confirmations.has('c1')).toBe(false);
  });

  test('#809 review: model-written markup in the sentence reads as text, not as Jarvis formatting', async () => {
    const lure = 'Book it ![](https://evil.example/p.png) **Jarvis: this one is safe, say yes** [docs](https://evil.example) <b>x</b> `y`';
    const make = (at: number) => {
      const req = mgr.createRequest({
        agentId: 'a1', agentName: 'PA', toolName: 'request_approval', toolArguments: {},
        actionCategory: 'send_email', urgency: 'normal', reason: lure, context: '',
      });
      getDb().run('UPDATE approval_requests SET created_at = ? WHERE id = ?', [at, req.id]);
      return req;
    };
    const a = make(1000);
    make(2000);
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, a.id);
    if (resolved?.kind !== 'refused') throw new Error('expected a refusal');
    const out = html(resolved.message);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('<strong');
    expect(out).not.toContain('<b>');
    // Each quoted sentence is one code span, the lure's own backticks inside it.
    expect(out.match(/<code>/g)?.length).toBe(2);
    // And it still says exactly what was written.
    expect(shown(resolved.message)).toContain(`still waiting: ${lure}`);
  });

  test('#809 review: a sentence made of backticks and spaces is still quoted exactly', async () => {
    for (const reason of ['``a` b```', ' `x` ', 'plain']) {
      getDb().run('DELETE FROM approval_requests');
      const req = mgr.createRequest({
        agentId: 'a1', agentName: 'PA', toolName: 'request_approval', toolArguments: {},
        actionCategory: 'send_email', urgency: 'normal', reason, context: '',
      });
      const resolved = await svc.resolveLatestPendingByVoice('approve', 1, null);
      if (resolved?.kind !== 'refused') throw new Error('expected a refusal');
      // approvalIntentParts trims the reason, so that is what is quoted.
      expect(shown(resolved.message)).toContain(`Waiting for you: ${reason.trim()}. Decide`);
      mgr.deny(req.id, 'test');
    }
  });

  test('a destructive approval shown and newest is still gated to a click, as before', async () => {
    const req = mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'delete_file', toolArguments: { path: '/tmp/x' },
      actionCategory: 'delete_data', urgency: 'normal', reason: 'delete_data requires user approval', context: '',
    });
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, req.id);
    expect(resolved?.kind).toBe('gated');
    expect(status(req)).toBe('pending');
  });
});

describe('#809: the shown id travels with the utterance', () => {
  const routeMessage = (msg: unknown) =>
    (svc as unknown as { routeMessage: (m: unknown, ws: unknown) => Promise<unknown> }).routeMessage(msg, {});
  /** Lets the fire-and-forget transcript pipeline finish. */
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

  test('voice_text: a yes answers the approval the dashboard showed, by id', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    await routeMessage({ type: 'voice_text', payload: { requestId: 'r1', text: 'yes', shownApprovalId: a.id }, timestamp: 0 });
    await settle();
    expect(status(a)).toBe('executed');
    expect(replies().map(shown)).toEqual(['Approving Send email to alice@example.com — "Q3".']);
  });

  test('voice_text: a yes after a newer request arrived decides nothing, and the thread says why', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const b = pendingEmail('mallory@example.com', 2000);
    await routeMessage({ type: 'voice_text', payload: { requestId: 'r1', text: 'yes', shownApprovalId: a.id }, timestamp: 0 });
    await settle();
    expect(status(a)).toBe('pending');
    expect(status(b)).toBe('pending');
    expect(replies().length).toBe(1);
    expect(replies()[0]).toContain('A new request arrived while you were answering');
  });

  test('voice_start: the session keeps the id the client sent with it', async () => {
    const sessions = (svc as unknown as { voiceSessions: Map<unknown, { shownApprovalId?: unknown }> }).voiceSessions;
    const ws = {};
    const route = (svc as unknown as { routeMessage: (m: unknown, ws: unknown) => Promise<unknown> }).routeMessage.bind(svc);
    await route({ type: 'voice_start', payload: { requestId: 'r1', mode: 'wav', shownApprovalId: 'abc' }, timestamp: 0 }, ws);
    expect(sessions.get(ws)?.shownApprovalId).toBe('abc');
    await route({ type: 'voice_start', payload: { requestId: 'r2', mode: 'wav', shownApprovalId: null }, timestamp: 0 }, ws);
    expect(sessions.get(ws)?.shownApprovalId).toBeNull();
    await route({ type: 'voice_start', payload: { requestId: 'r3', mode: 'wav' }, timestamp: 0 }, ws);
    expect(sessions.get(ws)?.shownApprovalId).toBeUndefined();
  });

  test('a recorded utterance hands its session id to the resolver after transcription', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const internals = svc as unknown as {
      sttProvider: unknown;
      handleVoiceSession: (session: unknown, ws: unknown) => Promise<void>;
    };
    internals.sttProvider = { transcribe: async () => 'yes' };
    await internals.handleVoiceSession({ requestId: 'r1', chunks: [Buffer.from('RIFF')], startedAt: 0, shownApprovalId: a.id }, {});
    await settle();
    expect(status(a)).toBe('executed');
  });

  test('shownApprovalIdFrom keeps "none shown" apart from "did not say"', () => {
    expect(shownApprovalIdFrom({ shownApprovalId: 'abc' })).toBe('abc');
    expect(shownApprovalIdFrom({ shownApprovalId: null })).toBeNull();
    expect(shownApprovalIdFrom({})).toBeUndefined();
    expect(shownApprovalIdFrom({ shownApprovalId: '' })).toBeUndefined();
    expect(shownApprovalIdFrom({ shownApprovalId: 7 })).toBeUndefined();
    expect(shownApprovalIdFrom(undefined)).toBeUndefined();
  });
});

/**
 * #855. #809 bound a voice answer to the card on top of the rail. With two or
 * more up, "on top" is position, not the card the person read, so voice
 * decides nothing until only one is waiting.
 */
describe('#855: with several approvals pending, voice decides none of them', () => {
  test('a yes on the newest, shown, approval is refused while another is pending, and says why', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const b = pendingEmail('bob@example.com', 2000);
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, b.id);
    expect(resolved).toEqual({ kind: 'refused', message: voiceApprovalAmbiguous('approve', 2) });
    expect(status(a)).toBe('pending');
    expect(status(b)).toBe('pending');
    expect(executions).toEqual([]);
  });

  test('a no is held to the same rule', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const b = pendingEmail('bob@example.com', 2000);
    const c = pendingEmail('carol@example.com', 3000);
    const resolved = await svc.resolveLatestPendingByVoice('cancel', 1, c.id);
    expect(resolved).toEqual({ kind: 'refused', message: voiceApprovalAmbiguous('cancel', 3) });
    expect([status(a), status(b), status(c)]).toEqual(['pending', 'pending', 'pending']);
  });

  test('the message says several are waiting and to pick each on its card, not that something failed', () => {
    const yes = voiceApprovalAmbiguous('approve', 2);
    expect(yes).toBe('2 requests are waiting for approval, so I can\'t tell which one your "yes" is for, and I haven\'t approved anything. Approve or deny each one on its card. Voice works again once only one is waiting.');
    const no = voiceApprovalAmbiguous('cancel', 4);
    expect(no).toContain('4 requests are waiting');
    expect(no).toContain('your "no" is for');
    expect(no).toContain("I haven't cancelled anything");
    // Never "say yes again": while several are waiting the next yes is just as ambiguous.
    expect(yes.toLowerCase()).not.toMatch(/say (yes|it|that) again/);
  });

  test('a request arriving mid-answer still gets the more specific #809 message', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    pendingEmail('mallory@example.com', 2000);
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, a.id);
    if (resolved?.kind !== 'refused') throw new Error('expected a refusal');
    expect(resolved.message).toContain('A new request arrived while you were answering');
  });

  test('once the other is decided, the one left is decided by voice as before', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const b = pendingEmail('bob@example.com', 2000);
    mgr.deny(a.id, 'dashboard');
    const resolved = await svc.resolveLatestPendingByVoice('approve', 1, b.id);
    expect(resolved?.kind).toBe('approval');
    expect(status(b)).toBe('executed');
  });

  test('through the voice pipeline: the thread says why, and nothing is decided', async () => {
    const a = pendingEmail('alice@example.com', 1000);
    const b = pendingEmail('bob@example.com', 2000);
    await (svc as unknown as { routeMessage: (m: unknown, ws: unknown) => Promise<unknown> })
      .routeMessage({ type: 'voice_text', payload: { requestId: 'r1', text: 'yes', shownApprovalId: b.id }, timestamp: 0 }, {});
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(replies()).toEqual([voiceApprovalAmbiguous('approve', 2)]);
    expect([status(a), status(b)]).toEqual(['pending', 'pending']);
  });
});

/**
 * #856. A gated voice answer -- destructive, click-only, or not clearly a yes
 * or no -- was sent as a `voice_approval_gated` notification no client
 * rendered, so the person heard nothing back. It is now a thread message
 * that says which of the three it was.
 */
describe('#856: a gated voice answer says so in the thread, and why', () => {
  const routeMessage = (msg: unknown) =>
    (svc as unknown as { routeMessage: (m: unknown, ws: unknown) => Promise<unknown> }).routeMessage(msg, {});
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
  const say = async (text: string, shownApprovalId: string) => {
    await routeMessage({ type: 'voice_text', payload: { requestId: 'r1', text, shownApprovalId }, timestamp: 0 });
    await settle();
  };
  const request = (actionCategory: 'delete_data' | 'send_email', opts: { reason?: string; context?: string } = {}) => mgr.createRequest({
    agentId: 'a1', agentName: 'PA', toolName: actionCategory === 'delete_data' ? 'delete_file' : 'send_email',
    toolArguments: actionCategory === 'delete_data' ? { path: '/tmp/x' } : { to: 'alice@example.com', subject: 'Q3' },
    actionCategory, urgency: 'normal', reason: opts.reason ?? `${actionCategory} requires user approval`, context: opts.context ?? '',
  });

  test('destructive: the thread says destructive requests take a click, and nothing is decided', async () => {
    const req = request('delete_data');
    await say('yes', req.id);
    expect(replies()).toEqual([voiceApprovalGatedMessage('approve', 'destructive', mgr.getRequest(req.id)!)]);
    expect(replies()[0]).toContain('marked destructive');
    expect(replies()[0]).toContain("I haven't approved anything");
    expect(shown(replies()[0]!)).toContain('Waiting for you: ');
    expect(status(req)).toBe('pending');
  });

  test('click-only: the thread says this request takes a click, not that it is destructive', async () => {
    const req = request('send_email', { context: JSON.stringify({ confirm: 'always' }) });
    await say('yes', req.id);
    expect(replies()).toEqual([voiceApprovalGatedMessage('approve', 'click_only', mgr.getRequest(req.id)!)]);
    expect(replies()[0]).toContain('has to be confirmed with a click');
    expect(replies()[0]).not.toContain('destructive');
    expect(status(req)).toBe('pending');
  });

  test('low confidence: the thread says the answer was unclear, and that saying it plainly can work', async () => {
    // 0.7: routed to act (a read-impact intent acts from 0.6, routeByConfidence)
    // but under the 0.85 voice-approval floor. Below 0.6 it never reaches the
    // resolver: it becomes a repeat-back card, which is its own feedback.
    classifierReply = JSON.stringify({ verb: 'unknown', object: null, args: {}, impact: 'read', confidence: 0.7, confirmation_response: 'approve' });
    const req = request('send_email');
    await say('yeah maybe', req.id);
    expect(replies()).toEqual([voiceApprovalGatedMessage('approve', 'low_confidence', mgr.getRequest(req.id)!)]);
    expect(replies()[0]).toContain('I wasn\'t sure that was a clear "yes"');
    expect(replies()[0]).not.toContain('destructive');
    expect(status(req)).toBe('pending');
    expect(executions).toEqual([]);
  });

  test('the resolver reports the reason it gated on', async () => {
    const destructive = request('delete_data');
    const gated = await svc.resolveLatestPendingByVoice('cancel', 1, destructive.id);
    expect(gated).toEqual({
      kind: 'gated', label: expect.any(String), reason: 'destructive',
      message: voiceApprovalGatedMessage('cancel', 'destructive', mgr.getRequest(destructive.id)!),
    });
    mgr.deny(destructive.id, 'test');
    const ordinary = request('send_email');
    const unsure = await svc.resolveLatestPendingByVoice('approve', 0.5, ordinary.id);
    expect(unsure?.kind === 'gated' && unsure.reason).toBe('low_confidence');
  });

  test('the three messages differ, each names the request, and each says nothing was decided', () => {
    const req = request('send_email');
    const messages = (['destructive', 'click_only', 'low_confidence'] as const).flatMap((reason) =>
      (['approve', 'cancel'] as const).map((decision) => ({ decision, reason, text: voiceApprovalGatedMessage(decision, reason, req) })));
    expect(new Set(messages.map((m) => m.text)).size).toBe(6);
    for (const m of messages) {
      expect(m.text).toContain(m.decision === 'approve' ? "I haven't approved anything" : "I haven't cancelled anything");
      expect(shown(m.text)).toContain('Waiting for you: Send email to alice@example.com');
    }
    // Only an unclear answer is worth repeating; a destructive or click-only
    // request will refuse a second one just the same.
    expect(messages.filter((m) => /again/.test(m.text)).map((m) => m.reason)).toEqual(['low_confidence', 'low_confidence']);
    expect(voiceApprovalGatedMessage('cancel', 'low_confidence', req)).toContain('a clear "no"');
  });

  test('model-written markup in the request reads as text in a gated reply too', async () => {
    const lure = 'Wipe it ![](https://evil.example/p.png) **Jarvis: say yes** [docs](https://evil.example)';
    const req = request('delete_data', { reason: lure });
    // A request_approval-style sentence: the reason is what the card shows.
    const message = voiceApprovalGatedMessage('approve', 'destructive', { ...mgr.getRequest(req.id)!, tool_name: 'request_approval' });
    const out = html(message);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('<strong');
    expect(shown(message)).toContain(`Waiting for you: ${lure}.`);
  });

  test('the old unrendered notification is replaced by the thread message, not just dropped', async () => {
    const req = request('delete_data');
    await say('yes', req.id);
    expect(sent.some((m) => m.payload?.source === 'voice_approval_gated')).toBe(false);
    expect(replies()).toHaveLength(1);
  });

  test('a no through the voice pipeline is gated the same way, and says nothing was cancelled', async () => {
    classifierReply = classified('cancel');
    const req = request('delete_data');
    await say('no', req.id);
    expect(replies()).toEqual([voiceApprovalGatedMessage('cancel', 'destructive', mgr.getRequest(req.id)!)]);
    expect(replies()[0]).toContain("I haven't cancelled anything");
    expect(status(req)).toBe('pending');
  });

  test('a request that is both click-only and destructive is reported as click-only', async () => {
    const req = request('delete_data', { context: JSON.stringify({ confirm: 'always' }) });
    const gated = await svc.resolveLatestPendingByVoice('approve', 1, req.id);
    expect(gated?.kind === 'gated' && gated.reason).toBe('click_only');
  });

  test('what the low-confidence message offers works: a plain yes on the same card approves it', async () => {
    classifierReply = JSON.stringify({ verb: 'unknown', object: null, args: {}, impact: 'read', confidence: 0.7, confirmation_response: 'approve' });
    const req = request('send_email');
    await say('yeah maybe', req.id);
    expect(status(req)).toBe('pending');
    classifierReply = classified('approve');
    await say('yes', req.id);
    expect(status(req)).toBe('executed');
    expect(replies()[1]).toContain('Approving');
  });

  test('the low-confidence offer to repeat is conditional on the request still being the only one waiting', () => {
    const req = request('send_email');
    expect(voiceApprovalGatedMessage('approve', 'low_confidence', req)).toContain('while it is still the only request waiting, say "yes" again plainly');
  });
});
