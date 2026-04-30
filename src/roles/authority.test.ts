import { describe, expect, test } from 'bun:test';
import {
  IMPACT_MAP,
  impactFromCategory,
  gateVoiceApprovalResolution,
  VOICE_APPROVAL_CONFIDENCE_FLOOR,
  type ActionCategory,
} from './authority.ts';

describe('IMPACT_MAP / impactFromCategory', () => {
  test('every ActionCategory has an impact assigned (no missing entries)', () => {
    const allCategories: ActionCategory[] = [
      'read_data', 'write_data', 'delete_data',
      'send_message', 'send_email',
      'execute_command', 'install_software',
      'make_payment', 'modify_settings',
      'spawn_agent', 'terminate_agent',
      'access_browser', 'control_app',
    ];
    for (const cat of allCategories) {
      const impact = impactFromCategory(cat);
      expect(['read', 'write', 'external', 'destructive']).toContain(impact);
    }
  });

  test('the destructive set matches what gateVoiceApprovalResolution refuses', () => {
    // Pinning the contract: if a category is mapped 'destructive' here, it
    // must be refused by the voice gate (no quiet drift).
    const destructive: ActionCategory[] = [
      'execute_command', 'install_software', 'make_payment',
      'modify_settings', 'delete_data', 'terminate_agent',
    ];
    for (const cat of destructive) {
      expect(IMPACT_MAP[cat]).toBe('destructive');
      const gate = gateVoiceApprovalResolution(cat, 1.0);
      expect(gate.kind).toBe('clarify');
      if (gate.kind === 'clarify') {
        expect(gate.reason).toBe('destructive_impact');
      }
    }
  });
});

describe('gateVoiceApprovalResolution — security gate for voice approvals', () => {
  // The reviewer's failure mode this gate prevents: STT mishears, podcasts,
  // or someone else in the room saying "yes" resolves the approval queue.
  // For destructive impacts (payment, deletion, termination), a single
  // misheard syllable triggering action is unacceptable.

  test('destructive impact is refused regardless of confidence (even 1.0)', () => {
    const cases: ActionCategory[] = ['make_payment', 'delete_data', 'terminate_agent', 'execute_command'];
    for (const cat of cases) {
      // Even with perfect confidence, voice cannot resolve destructive actions.
      const gate = gateVoiceApprovalResolution(cat, 1.0);
      expect(gate.kind).toBe('clarify');
      if (gate.kind === 'clarify') {
        expect(gate.reason).toBe('destructive_impact');
        expect(gate.message.toLowerCase()).toContain('dashboard');
      }
    }
  });

  test('non-destructive with confidence ≥ 0.85 resolves', () => {
    expect(gateVoiceApprovalResolution('read_data', 0.85).kind).toBe('resolve');
    expect(gateVoiceApprovalResolution('write_data', 0.9).kind).toBe('resolve');
    expect(gateVoiceApprovalResolution('send_message', 1.0).kind).toBe('resolve');
    expect(gateVoiceApprovalResolution('access_browser', 0.95).kind).toBe('resolve');
    expect(gateVoiceApprovalResolution('send_email', 0.86).kind).toBe('resolve');
  });

  test('non-destructive below 0.85 is gated as low_confidence', () => {
    const cases: Array<[ActionCategory, number]> = [
      ['read_data', 0.84],
      ['write_data', 0.6],
      ['send_message', 0.0],
      ['access_browser', 0.7],
    ];
    for (const [cat, conf] of cases) {
      const gate = gateVoiceApprovalResolution(cat, conf);
      expect(gate.kind).toBe('clarify');
      if (gate.kind === 'clarify') {
        expect(gate.reason).toBe('low_confidence');
        expect(gate.message.toLowerCase()).toContain('repeat');
      }
    }
  });

  test('the floor sits exactly at VOICE_APPROVAL_CONFIDENCE_FLOOR (boundary check)', () => {
    // Just below the floor: gated.
    expect(gateVoiceApprovalResolution('read_data', VOICE_APPROVAL_CONFIDENCE_FLOOR - 0.0001).kind).toBe('clarify');
    // At and above the floor: resolved.
    expect(gateVoiceApprovalResolution('read_data', VOICE_APPROVAL_CONFIDENCE_FLOOR).kind).toBe('resolve');
    expect(gateVoiceApprovalResolution('read_data', VOICE_APPROVAL_CONFIDENCE_FLOOR + 0.0001).kind).toBe('resolve');
  });

  test('destructive supersedes the confidence floor — no escape hatch', () => {
    // High confidence does NOT unlock destructive resolution. This is the
    // critical security property: confidence is necessary but not sufficient.
    expect(gateVoiceApprovalResolution('make_payment', 0.99).kind).toBe('clarify');
    expect(gateVoiceApprovalResolution('make_payment', 1.0).kind).toBe('clarify');
  });

  test('low confidence on a destructive action returns destructive_impact (impact takes priority over confidence)', () => {
    // The order matters for the audit reason: a payment with low confidence
    // should be tagged as gated for impact, not for confidence.
    const gate = gateVoiceApprovalResolution('make_payment', 0.1);
    expect(gate.kind).toBe('clarify');
    if (gate.kind === 'clarify') {
      expect(gate.reason).toBe('destructive_impact');
    }
  });

  test('clarify outcomes always carry a non-empty message for the user', () => {
    const cases: Array<[ActionCategory, number]> = [
      ['make_payment', 1.0],
      ['read_data', 0.5],
      ['delete_data', 0.7],
    ];
    for (const [cat, conf] of cases) {
      const gate = gateVoiceApprovalResolution(cat, conf);
      if (gate.kind === 'clarify') {
        expect(gate.message.length).toBeGreaterThan(0);
      }
    }
  });
});
