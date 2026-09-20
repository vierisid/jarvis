import { describe, expect, test } from 'bun:test';
import { classifyStep, resolveSkillEffect, UNRESOLVED_STEP_CATEGORY, SKILL_EFFECT_FLOOR } from './effects.ts';
import { stricterCategory } from '../authority/tool-action-map.ts';
import type { Skill, SkillStep } from './types.ts';
import type { SemanticRef } from '../structural/types.ts';

function ref(role: string, name: string): SemanticRef {
  return { role, name, path: [], ordinal: 0, sig: '' };
}

function skill(steps: SkillStep[], extra: Partial<Skill> = {}): Skill {
  return {
    id: 's', name: 'test', app: '', description: '', match: {}, params: [], steps,
    provenance: 'authored', version: 1, enabled: true, integrity: 'ok', successCount: 0, runCount: 0,
    createdAt: 0, updatedAt: 0, ...extra,
  };
}

describe('stricterCategory', () => {
  test('orders by required level, then by a fixed tie order', () => {
    expect(stricterCategory('control_app', 'send_email')).toBe('send_email');
    expect(stricterCategory('send_email', 'control_app')).toBe('send_email');
    expect(stricterCategory('control_app', 'send_message')).toBe('control_app');
    expect(stricterCategory('delete_data', 'make_payment')).toBe('make_payment');
    expect(stricterCategory('make_payment', 'delete_data')).toBe('make_payment');
    expect(stricterCategory('read_data', 'read_data')).toBe('read_data');
  });
});

describe('classifyStep', () => {
  test('every acting step is at least control_app; wait is not an act', () => {
    const s = skill([]);
    expect(classifyStep({ action: 'click', ref: ref('Button', 'OK') }, 0, s, {}).category).toBe(SKILL_EFFECT_FLOOR);
    expect(classifyStep({ action: 'set_value', ref: ref('Edit', 'Name'), value: 'x' }, 0, s, {}).category).toBe(SKILL_EFFECT_FLOOR);
    expect(classifyStep({ action: 'launch_app', value: 'notepad.exe' }, 0, s, {}).category).toBe(SKILL_EFFECT_FLOOR);
    expect(classifyStep({ action: 'wait', ms: 5 }, 0, s, {}).category).toBe('read_data');
  });

  test('a declared effect raises a step but cannot lower it below the floor', () => {
    const s = skill([]);
    expect(classifyStep({ action: 'click', ref: ref('Button', 'Save'), effect: 'send_email' }, 0, s, {}).category).toBe('send_email');
    expect(classifyStep({ action: 'click', ref: ref('Button', 'Save'), effect: 'read_data' }, 0, s, {}).category).toBe(SKILL_EFFECT_FLOOR);
    expect(classifyStep({ action: 'click', ref: ref('Button', 'Save'), effect: 'write_data' }, 0, s, {}).category).toBe(SKILL_EFFECT_FLOOR);
  });

  test('Send is email in a mail app and a message elsewhere; both are reached even when below the floor', () => {
    const gmail = skill([], { app: 'Gmail', match: { domains: ['mail.google.com'] } });
    const slack = skill([], { app: 'Slack' });
    const crm = skill([], { app: 'Acme CRM' });
    const g = classifyStep({ action: 'click', ref: ref('button', 'Send') }, 0, gmail, {});
    expect(g.category).toBe('send_email');
    expect(g.reached).toEqual(['send_email', 'control_app']);
    expect(g.summary).toBe('click Send (sends email)');
    // send_message (3) is below the floor (5): the step is gated as
    // control_app, but a config that governs send_message must still see it.
    const sl = classifyStep({ action: 'click', ref: ref('button', 'Send') }, 0, slack, {});
    expect(sl.category).toBe(SKILL_EFFECT_FLOOR);
    expect(sl.reached).toEqual(['control_app', 'send_message']);
    expect(sl.summary).toBe('click Send (sends a message)');
    const c = classifyStep({ action: 'click', ref: ref('button', 'Send') }, 0, crm, {});
    expect(c.category).toBe(SKILL_EFFECT_FLOOR);
    expect(c.reached).toContain('send_message');
  });

  test('Enter in a messaging composer sends; ctrl+enter in a mail app sends email', () => {
    const slack = skill([], { app: 'Slack' });
    const gmail = skill([], { app: 'Gmail' });
    const enter = classifyStep({ action: 'press_keys', value: 'enter' }, 0, slack, {});
    expect(enter.category).toBe(SKILL_EFFECT_FLOOR);
    expect(enter.reached).toEqual(['control_app', 'send_message']);
    expect(enter.summary).toBe('press enter (sends a message)');
    expect(classifyStep({ action: 'press_keys', value: 'enter' }, 0, skill([], { app: 'Notepad' }), {}).reached).toEqual(['control_app']);
    expect(classifyStep({ action: 'press_keys', value: 'ctrl+enter' }, 0, gmail, {}).category).toBe('send_email');
    expect(classifyStep({ action: 'press_keys', value: 'ctrl+enter' }, 0, slack, {}).category).toBe(SKILL_EFFECT_FLOOR);
  });

  test('payment, deletion and settings buttons are classified from their names', () => {
    const shop = skill([], { app: 'Shop' });
    expect(classifyStep({ action: 'click', ref: ref('button', 'Place your order') }, 0, shop, {}).category).toBe('make_payment');
    expect(classifyStep({ action: 'click', ref: ref('button', 'Buy now') }, 0, shop, {}).category).toBe('make_payment');
    expect(classifyStep({ action: 'click', ref: ref('button', 'Delete') }, 0, shop, {}).category).toBe('delete_data');
    expect(classifyStep({ action: 'click', ref: ref('button', 'Discard') }, 0, shop, {}).category).toBe('delete_data');
    expect(classifyStep({ action: 'click', ref: ref('button', 'Save settings') }, 0, shop, {}).category).toBe('modify_settings');
  });

  test('an unknown action is gated as the unresolved category', () => {
    const s = skill([]);
    const e = classifyStep({ action: 'hover' as unknown as SkillStep['action'], ref: ref('button', 'x') }, 0, s, {});
    expect(e.category).toBe(UNRESOLVED_STEP_CATEGORY);
    expect(e.summary).toContain('unknown action');
  });
});

describe('resolveSkillEffect', () => {
  test('takes the worst case across the steps and names it on the intent', () => {
    const s = skill([
      { action: 'click', ref: ref('button', 'Compose') },
      { action: 'set_value', ref: ref('textbox', 'To recipients'), value: '{{to}}' },
      { action: 'set_value', ref: ref('textbox', 'Subject'), value: '{{subject}}' },
      { action: 'click', ref: ref('button', 'Send') },
    ], { name: 'gmail-compose', app: 'Gmail', version: 3, params: [
      { name: 'to', type: 'string', description: '', required: true },
      { name: 'subject', type: 'string', description: '', required: true },
    ] });
    const e = resolveSkillEffect(s, { to: 'a@b.com', subject: 'Quarterly numbers for the board meeting on Thursday' });
    expect(e.category).toBe('send_email');
    expect(e.categories).toEqual(['send_email', 'control_app']);
    expect(e.invalid).toBeUndefined();
    expect(e.intent).toBe(
      'Run skill "gmail-compose" in Gmail (v3, authored): click Compose; type "a@b.com" into To recipients; type "Quarterly numbers for the board meeti..." into Subject; click Send (sends email). Business effect unknown for some UI steps; review the current screen and the full procedure before approving. UI effect labels are hints, not verified business outcomes.',
    );
  });

  test('a secret param never appears on the intent, by flag or by name', () => {
    const s = skill([
      { action: 'set_value', ref: ref('textbox', 'Username'), value: '{{username}}' },
      { action: 'set_value', ref: ref('textbox', 'Password'), value: '{{password}}' },
      { action: 'set_value', ref: ref('textbox', 'Code'), value: '{{code}}' },
    ], { params: [
      { name: 'username', type: 'string', description: '', required: true },
      { name: 'password', type: 'string', description: '', required: true },
      { name: 'code', type: 'string', description: '', required: true, secret: true },
    ] });
    const e = resolveSkillEffect(s, { username: 'vieri', password: 'hunter2', code: '123456' });
    expect(e.intent).toContain('"vieri" into Username');
    expect(e.intent).toContain('[secret] into Password');
    expect(e.intent).toContain('[secret] into Code');
    expect(e.intent).not.toContain('hunter2');
    expect(e.intent).not.toContain('123456');
  });

  test('the intent resolves recorded defaults, and a caller value overrides them', () => {
    const s = skill([
      { action: 'set_value', ref: ref('Document', 'Text editor'), value: '{{text_editor}}' },
    ], { name: 'notepad-expenses', app: 'Notepad', params: [
      { name: 'text_editor', type: 'string', description: '', required: false, default: 'coffee 4 euros' },
    ] });
    expect(resolveSkillEffect(s, {}).intent).toContain('type "coffee 4 euros" into Text editor');
    expect(resolveSkillEffect(s, { text_editor: 'taxi 12' }).intent).toContain('type "taxi 12" into Text editor');
  });

  test('a malformed skill is invalid and gated as the unresolved category', () => {
    const s = skill([{ action: 'click', ref: ref('button', 'OK') }, { action: 'swipe' as unknown as SkillStep['action'] }]);
    const e = resolveSkillEffect(s, {});
    expect(e.invalid).toContain('step 2 has an unknown action "swipe"');
    expect(e.category).toBe(UNRESOLVED_STEP_CATEGORY);
  });

  test('a skill that sends a message reaches send_message even though control_app is the higher level', () => {
    const s = skill([
      { action: 'set_value', ref: ref('textbox', 'Message input'), value: 'hi' },
      { action: 'press_keys', value: 'enter', effect: 'send_message' },
    ], { app: 'Slack' });
    const e = resolveSkillEffect(s, {});
    expect(e.category).toBe('control_app');
    expect(e.categories).toEqual(['control_app', 'send_message']);
  });

  test('a long skill truncates the intent and counts the rest', () => {
    const steps: SkillStep[] = Array.from({ length: 12 }, (_, i) => ({ action: 'click', ref: ref('button', `B${i}`) }));
    const e = resolveSkillEffect(skill(steps), {});
    expect(e.intent).toContain('click B7');
    expect(e.intent).not.toContain('click B8');
    expect(e.intent).toContain('+4 more steps');
  });
});
