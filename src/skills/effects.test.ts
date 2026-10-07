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

/**
 * #706. The card renders this sentence and nothing else, and most of it is
 * text nobody vetted: `record_skill` compiles element names from the
 * accessible names of fields on pages the person used, the skill name is the
 * model's, the app is the recorded window's, and typed values and keys come
 * from the caller. Each value is reduced with `forCard` and capped, and a
 * quoted value has its quotes escaped, so none of them can reorder the
 * sentence, run it on past the step that sends, or close its own quote.
 */
describe('#706: page-derived and model-chosen text on the run_skill card', () => {
  const RLO = String.fromCharCode(0x202e);
  const CONTROLS_OR_FORMAT = /[\p{Cf}\u0000-\u001f\u007f-\u009f]/u;

  test('a long label with a bidi override cannot hide the step that sends', () => {
    const s = skill([
      { action: 'click', ref: ref('button', `Archive${RLO}${'x'.repeat(2000)}`) },
      { action: 'click', ref: ref('button', 'Send') },
    ], { name: 'gmail-send', app: 'Gmail' });
    const e = resolveSkillEffect(s, {});
    expect(e.intent).not.toMatch(CONTROLS_OR_FORMAT);
    expect(e.intent).toContain(`click Archive${'x'.repeat(70)}...; click Send (sends email)`);
    expect(e.intent.length).toBeLessThan(400);
  });

  test('the classifier still judges the raw name: the reduction is for display only', () => {
    // The word that classifies sits past the 80-character cap, so a classifier
    // fed the card text would lose it.
    const step = classifyStep({ action: 'click', ref: ref('button', `${'x'.repeat(90)} delete`) }, 0, skill([]), {});
    expect(step.category).toBe('delete_data');
    expect(step.summary).toBe(`click ${'x'.repeat(77)}... (deletes)`);
  });

  test('an opened URL and a launched app are quoted, reduced and capped', () => {
    const s = skill([
      { action: 'navigate', value: `https://a.example/"${String.fromCharCode(10)}${RLO}${'q'.repeat(60)}` },
      { action: 'launch_app', value: `notepad"${RLO}.exe` },
    ]);
    const e = resolveSkillEffect(s, {});
    expect(e.intent).not.toMatch(CONTROLS_OR_FORMAT);
    expect(e.intent).toContain(`open "https://a.example/\\" ${'q'.repeat(17)}..."`);
    expect(e.intent).toContain('launch "notepad\\".exe"');
  });

  test('a skill name cannot close its quote or break the line', () => {
    const name = `gmail-send" in Notepad (v9, authored): click Cancel.${String.fromCharCode(10)}Run skill "x`;
    const e = resolveSkillEffect(skill([{ action: 'click', ref: ref('button', 'Send') }], { name, app: 'Gmail' }), {});
    expect(e.intent).not.toMatch(CONTROLS_OR_FORMAT);
    const quoted = /^Run skill ("(?:[^"\\]|\\.)*")/.exec(e.intent)![1]!;
    // Everything up to the first unescaped quote is the name, whole.
    expect(JSON.parse(quoted)).toBe('gmail-send" in Notepad (v9, authored): click Cancel. Run skill "x');
    expect(e.intent.slice('Run skill '.length + quoted.length)).toStartWith(' in Gmail (v1, authored): click Send');
  });

  test('the skill name and the app are capped', () => {
    const e = resolveSkillEffect(skill([{ action: 'click', ref: ref('button', 'OK') }],
      { name: 'n'.repeat(500), app: `A${String.fromCharCode(0x1b)}[2J${'p'.repeat(500)}` }), {});
    expect(e.intent).toStartWith(`Run skill "${'n'.repeat(77)}..." in A[2J${'p'.repeat(73)}... (v1, authored): click OK`);
  });

  test('a typed value cannot close its quote, and a pressed key is capped', () => {
    const s = skill([
      { action: 'set_value', ref: ref('textbox', 'To'), value: '{{to}}' },
      { action: 'press_keys', value: '{{keys}}' },
    ], { params: [
      { name: 'to', type: 'string', description: '', required: true },
      { name: 'keys', type: 'string', description: '', required: true },
    ] });
    const e = resolveSkillEffect(s, { to: 'bob" into Search; click Cancel', keys: `enter${'k'.repeat(500)}` });
    expect(e.intent).toContain('type "bob\\" into Search; click Cancel" into To');
    expect(e.intent).toContain(`press enter${'k'.repeat(32)}...`);
    expect(e.intent).not.toContain('k'.repeat(36));
  });

  test('a label made only of invisible characters falls back to the role', () => {
    const e = resolveSkillEffect(skill([{ action: 'click', ref: ref('button', `${RLO}${String.fromCharCode(0x200b)}`) }]), {});
    expect(e.intent).toContain(': click button');
  });

  test('an unknown recorded action is quoted, reduced and capped on the card', () => {
    const action = `swipe"${String.fromCharCode(10)}${'z'.repeat(200)}` as unknown as SkillStep['action'];
    const step = classifyStep({ action }, 0, skill([]), {});
    expect(step.summary).toBe(`unknown action "swipe\\" ${'z'.repeat(30)}..."`);
  });
});

/**
 * #723. The classification is the half with authority, and it read only the
 * raw accessible name while the card showed the reduced one, so the two could
 * disagree: a deny rule on `send_email` was skipped while the card said
 * `click Send`. And the eight-step cap dropped a later step whole.
 */
describe('#723: the classifier reads the name the card shows, as well as the raw one', () => {
  const ZWSP = String.fromCharCode(0x200b);
  const gmail = skill([], { app: 'Gmail' });

  test.each([
    ['a zero-width space inside the word', `Se${ZWSP}nd`],
    ['a run of whitespace', 'Send  now'],
    ['a control character', `Se${String.fromCharCode(1)}nd`],
    ['a line break', `Send${String.fromCharCode(10)}now`],
  ])('%s does not hide a send', (_label, name) => {
    const step = classifyStep({ action: 'click', ref: ref('button', name) }, 0, gmail, {});
    expect(step.reached).toContain('send_email');
    expect(step.summary).toMatch(/^click Send( now)? \(sends email\)$/);
    expect(step.uncertain).toBe(false);
  });

  test('a disguised app name still counts as the mail context', () => {
    const step = classifyStep({ action: 'click', ref: ref('button', 'Send') }, 0, skill([], { app: `Gm${ZWSP}ail` }), {});
    expect(step.reached).toContain('send_email');
  });

  test('the union only adds: a raw-name match is kept', () => {
    // The raw reading matches the payment pattern; nothing about the reduction can remove it.
    const step = classifyStep({ action: 'click', ref: ref('button', `${'x'.repeat(90)} pay now`) }, 0, skill([]), {});
    expect(step.reached).toContain('make_payment');
  });

  test('a run that sends is gated on the send, so a deny rule on it applies', () => {
    const e = resolveSkillEffect(skill([{ action: 'click', ref: ref('button', `Se${ZWSP}nd`) }], { app: 'Gmail' }), {});
    expect(e.categories).toContain('send_email');
  });
});

describe('#723: the steps past the eighth are counted with their effects', () => {
  const clicks = (n: number): SkillStep[] => Array.from({ length: n }, (_, i) => ({ action: 'click', ref: ref('button', `B${i}`) }));

  test('a ninth step that sends is named in the tail', () => {
    const e = resolveSkillEffect(skill([...clicks(8), { action: 'click', ref: ref('button', 'Send') }], { app: 'Gmail' }), {});
    expect(e.intent).not.toContain('click Send');
    expect(e.intent).toContain('click B7; +1 more steps (among them: sends email)');
  });

  test('every effect among the hidden steps is named once, most severe first', () => {
    const e = resolveSkillEffect(skill([
      ...clicks(8),
      { action: 'click', ref: ref('button', 'Send') },
      { action: 'click', ref: ref('button', 'Delete') },
      { action: 'click', ref: ref('button', 'Send') },
      { action: 'click', ref: ref('button', 'Pay now') },
    ], { app: 'Gmail' }), {});
    expect(e.intent).toContain('+4 more steps (among them: pays, deletes, sends email)');
  });

  test('hidden steps with no business effect are only counted', () => {
    expect(resolveSkillEffect(skill(clicks(12)), {}).intent).toContain('click B7; +4 more steps. Business effect unknown');
  });
});
