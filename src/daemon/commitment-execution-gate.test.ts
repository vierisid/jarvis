/**
 * P0.2 — regression boundary for "an overheard or inferred sentence became an
 * autonomous, tool-holding agent run five seconds after a notification".
 *
 * The shipped default aggressiveness is `aggressive` (5s cancel window), so
 * these gates are what stands between a low-quality extraction and an
 * unattended action.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  CommitmentExecutor,
  executionEligibility,
  DEFAULT_CONFIDENCE_FLOOR,
  type BroadcastFn,
} from './commitment-executor.ts';
import { createCommitment, getCommitment } from '../vault/commitments.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import type { WSMessage } from '../comms/websocket.ts';

describe('executionEligibility', () => {
  const base = { kind: 'task' as const, assigned_to: null, confidence: 1.0 };

  it('allows a confident, self-owned task', () => {
    expect(executionEligibility(base).eligible).toBe(true);
    expect(executionEligibility({ ...base, assigned_to: 'jarvis' }).eligible).toBe(true);
  });

  it('refuses a reminder — that is for a person to act on', () => {
    const out = executionEligibility({ ...base, kind: 'reminder' });
    expect(out.eligible).toBe(false);
    expect(out.eligible === false && out.reason).toBe('kind');
  });

  it('refuses a row assigned to a human', () => {
    const out = executionEligibility({ ...base, assigned_to: 'Sarah' });
    expect(out.eligible).toBe(false);
    expect(out.eligible === false && out.reason).toBe('assigned_to_other');
  });

  it('refuses a row assigned to another agent', () => {
    // delegation.ts writes the child agent's id here; that child owns the work.
    const out = executionEligibility({ ...base, assigned_to: 'agent-7f3a' });
    expect(out.eligible === false && out.reason).toBe('assigned_to_other');
  });

  it('refuses a row below the confidence floor', () => {
    const out = executionEligibility({ ...base, confidence: DEFAULT_CONFIDENCE_FLOOR - 0.01 });
    expect(out.eligible).toBe(false);
    expect(out.eligible === false && out.reason).toBe('low_confidence');
  });

  it('treats a missing confidence as below the floor, not as trusted', () => {
    // This is the one that matters: every row written before P0.2, and every
    // row the LLM extractor writes without a confidence, lands here.
    const out = executionEligibility({ ...base, confidence: null });
    expect(out.eligible).toBe(false);
    expect(out.eligible === false && out.reason).toBe('low_confidence');
  });

  it('honours a custom floor', () => {
    expect(executionEligibility({ ...base, confidence: 0.5 }, 0.4).eligible).toBe(true);
    expect(executionEligibility({ ...base, confidence: 0.5 }, 0.6).eligible).toBe(false);
  });
});

describe('CommitmentExecutor announcement (aggressive mode)', () => {
  let messages: WSMessage[];
  const broadcast: BroadcastFn = (m) => { messages.push(m); };

  beforeEach(() => {
    initDatabase(':memory:');
    messages = [];
  });
  afterEach(() => closeDb());

  /** The `pending_execution` notification payload for the newest announcement. */
  function lastAnnouncement(): Record<string, unknown> {
    const msg = [...messages].reverse().find(
      (m) => m.type === 'notification' &&
        (m.payload as Record<string, unknown>)?.action === 'pending_execution',
    );
    return (msg?.payload ?? {}) as Record<string, unknown>;
  }

  function runDue(): void {
    const executor = new CommitmentExecutor('aggressive');
    executor.setBroadcast(broadcast);
    executor.checkAndAnnounce();
    executor.stop();
  }

  it('schedules execution for a confident self-owned task', () => {
    createCommitment('rotate the API key', {
      when_due: Date.now() - 1000,
      confidence: 1.0,
    });
    runDue();

    const payload = lastAnnouncement();
    expect(payload.autoExecute).toBe(true);
    expect(payload.executeAt).not.toBeNull();
  });

  it('announces without scheduling when confidence is missing', () => {
    createCommitment('email the investors', { when_due: Date.now() - 1000 });
    runDue();

    const payload = lastAnnouncement();
    expect(payload.autoExecute).toBe(false);
    expect(payload.executeAt).toBeNull();
    expect(payload.blockedReason).toBe('low_confidence');
  });

  it('announces without scheduling for a reminder', () => {
    createCommitment('standup at 9', {
      when_due: Date.now() - 1000,
      kind: 'reminder',
      confidence: 1.0,
    });
    runDue();

    const payload = lastAnnouncement();
    expect(payload.autoExecute).toBe(false);
    expect(payload.blockedReason).toBe('kind');
  });

  it('announces without scheduling when a human owns the row', () => {
    createCommitment('Sarah sends the deck', {
      when_due: Date.now() - 1000,
      assigned_to: 'Sarah',
      confidence: 1.0,
    });
    runDue();

    const payload = lastAnnouncement();
    expect(payload.autoExecute).toBe(false);
    expect(payload.blockedReason).toBe('assigned_to_other');
  });

  it('tells the user a gated row is waiting on them, not counting down', () => {
    createCommitment('email the investors', { when_due: Date.now() - 1000 });
    runDue();

    const chat = messages.find((m) => m.type === 'chat');
    expect(String((chat?.payload as Record<string, unknown>)?.text)).toContain('Waiting for your instruction');
  });
});

describe('commitments vault columns', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDb());

  it('defaults kind to task and confidence to null', () => {
    const c = createCommitment('do a thing');
    expect(c.kind).toBe('task');
    expect(c.confidence).toBeNull();

    const readBack = getCommitment(c.id);
    expect(readBack?.kind).toBe('task');
    expect(readBack?.confidence).toBeNull();
  });

  it('round-trips kind and confidence', () => {
    const c = createCommitment('remind me', { kind: 'reminder', confidence: 0.42 });
    const readBack = getCommitment(c.id);
    expect(readBack?.kind).toBe('reminder');
    expect(readBack?.confidence).toBeCloseTo(0.42);
  });
});
