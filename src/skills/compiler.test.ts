import { describe, expect, it } from 'bun:test';
import { compileSkill } from './compiler.ts';
import { parseInteractionEvent, redactInteraction, looksSecret, SkillRecorder, type RawInteraction } from './recorder.ts';
import type { SemanticRef } from '../structural/types.ts';

function ref(role: string, name: string, sig = ''): SemanticRef {
  return { role, name, path: [], ordinal: 0, sig };
}
function ev(p: Partial<RawInteraction> & { action: RawInteraction['action'] }): RawInteraction {
  return { ts: 0, surface: 'browser', ...p };
}

describe('recorder redaction', () => {
  it('flags password fields and secret-looking values', () => {
    expect(looksSecret('hunter2', ref('textbox', 'Password'))).toBe(true);
    expect(looksSecret('4111111111111111', ref('textbox', 'Card number'))).toBe(true);
    expect(looksSecret('sk-abcdefghijklmnop1234', ref('textbox', 'Key'))).toBe(true);
    expect(looksSecret('hello world', ref('textbox', 'Body'))).toBe(false);
  });

  it('redacts value at capture time', () => {
    const r = redactInteraction(ev({ action: 'set_value', ref: ref('textbox', 'Password'), value: 'hunter2' }));
    expect(r.value).toBe('{{REDACTED}}');
    expect(r.secure).toBe(true);
  });

  it('SkillRecorder buffers redacted interactions and keeps them pending after end', () => {
    const rec = new SkillRecorder();
    rec.start('s1', 1000, 60_000);
    rec.push(ev({ action: 'set_value', ref: ref('textbox', 'Password'), value: 'secret!' }), 1001);
    rec.push(ev({ action: 'click', ref: ref('button', 'Login') }), 1002);
    const session = rec.end('stop', 1003);
    expect(session!.interactions).toHaveLength(2);
    expect(session!.interactions[0]!.value).toBe('{{REDACTED}}');
    expect(rec.isRecording()).toBe(false);
    // Pending until taken: a stop that could not save can retry.
    expect(rec.pending()!.id).toBe('s1');
    rec.push(ev({ action: 'click', ref: ref('button', 'Late') }), 1004);
    expect(rec.pending()!.interactions).toHaveLength(2);
    expect(rec.takePending()!.id).toBe('s1');
    expect(rec.pending()).toBeNull();
  });

  it('a session stops accepting interactions at its deadline', () => {
    const rec = new SkillRecorder();
    rec.start('s2', 1000, 500);
    rec.push(ev({ action: 'click', ref: ref('button', 'A') }), 1400);
    expect(rec.isRecording(1499)).toBe(true);
    expect(rec.isRecording(1500)).toBe(false);
    rec.push(ev({ action: 'click', ref: ref('button', 'B') }), 1600);
    expect(rec.end('cap', 1600)!.interactions.map((i) => i.ref!.name)).toEqual(['A']);
  });
});

describe('parseInteractionEvent', () => {
  const goodRef = { role: 'Button', name: 'Send', path: [], ordinal: 0, sig: 'abc' };

  it('accepts a well-formed click and a commit', () => {
    const click = parseInteractionEvent({ action: 'click', ref: goodRef, ts: 5, app: 'chrome', title: 'Inbox', surface: 'desktop' })!;
    expect(click.action).toBe('click');
    expect(click.app).toBe('chrome');
    expect(click.title).toBe('Inbox');
    const commit = parseInteractionEvent({ action: 'set_value', ref: goodRef, value: 'hi', secure: false })!;
    expect(commit.value).toBe('hi');
    expect(commit.secure).toBe(false);
  });

  it('drops an unknown action instead of coercing it to a click', () => {
    expect(parseInteractionEvent({ action: 'hover', ref: goodRef })).toBeNull();
    expect(parseInteractionEvent({ ref: goodRef })).toBeNull();
  });

  it('drops an element action without a well-formed ref', () => {
    expect(parseInteractionEvent({ action: 'click' })).toBeNull();
    expect(parseInteractionEvent({ action: 'click', ref: { role: 'Button' } })).toBeNull();
    expect(parseInteractionEvent({ action: 'set_value', ref: 'Send', value: 'x' })).toBeNull();
    expect(parseInteractionEvent(null)).toBeNull();
    expect(parseInteractionEvent('click')).toBeNull();
  });

  it('a secure commit without a value is kept (the brain treats it as redacted)', () => {
    const r = parseInteractionEvent({ action: 'set_value', ref: goodRef, secure: true })!;
    expect(r.secure).toBe(true);
    expect(r.value).toBeUndefined();
  });
});

describe('compileSkill', () => {
  it('coalesces click-then-type on the same field into one set_value', () => {
    const interactions = [
      ev({ action: 'click', ref: ref('textbox', 'To', 'to-sig') }),
      ev({ action: 'set_value', ref: ref('textbox', 'To', 'to-sig'), value: 'a@b.com' }),
    ];
    const skill = compileSkill(interactions, { name: 'x' });
    expect(skill.steps).toHaveLength(1);
    expect(skill.steps[0]!.action).toBe('set_value');
  });

  it('parameterizes typed values, names params from field labels, and keeps the typed text as the default', () => {
    const skill = compileSkill(
      [
        ev({ action: 'set_value', ref: ref('textbox', 'Subject'), value: 'Hi there' }),
        ev({ action: 'set_value', ref: ref('textbox', 'Message Body'), value: 'body text' }),
      ],
      { name: 'compose' },
    );
    expect(skill.params.map((p) => p.name)).toEqual(['subject', 'message_body']);
    // The step never carries the literal; the param's default does.
    expect(skill.steps[0]!.value).toBe('{{subject}}');
    expect(skill.steps[0]!.postcondition).toEqual({ kind: 'value_equals', value: '{{subject}}' });
    expect(skill.params[0]).toMatchObject({ required: false, default: 'Hi there' });
    expect(skill.params[1]).toMatchObject({ required: false, default: 'body text' });
    expect(skill.params[0]!.secret).toBeUndefined();
  });

  it('turns a redacted secret into a required secret param with no default and NO value_equals postcondition', () => {
    const skill = compileSkill(
      [ev({ action: 'set_value', ref: ref('textbox', 'Password'), value: '{{REDACTED}}', secure: true })],
      { name: 'login' },
    );
    expect(skill.params).toHaveLength(1);
    expect(skill.params[0]).toMatchObject({ required: true, secret: true });
    expect(skill.params[0]!.default).toBeUndefined();
    expect(JSON.stringify(skill)).not.toContain('REDACTED');
    expect(skill.steps[0]!.postcondition).toBeUndefined(); // masked field won't read back
  });

  it('a secure field with no value at all (password field the sidecar withheld) is also required with no default', () => {
    const skill = compileSkill([ev({ action: 'set_value', ref: ref('Edit', 'PIN'), secure: true })], { name: 'pin' });
    expect(skill.params[0]).toMatchObject({ required: true, secret: true });
    expect(skill.params[0]!.default).toBeUndefined();
  });

  it('gives a terminal click a surface_changed postcondition and keeps the surface on every step', () => {
    const skill = compileSkill(
      [
        ev({ action: 'set_value', ref: ref('textbox', 'To'), value: 'a@b.com', surface: 'desktop', app: 'chrome' }),
        ev({ action: 'click', ref: ref('button', 'Send'), surface: 'desktop', app: 'chrome' }),
      ],
      { name: 'gmail', app: 'Gmail' },
    );
    const send = skill.steps[skill.steps.length - 1]!;
    expect(send.action).toBe('click');
    expect(send.postcondition).toEqual({ kind: 'surface_changed' });
    expect(skill.steps.every((s) => s.surface === 'desktop')).toBe(true);
    expect(skill.app).toBe('Gmail');
    expect(skill.match.processNames).toEqual(['chrome']);
  });

  it('typing an app name into Windows search becomes a launch step, and search clicks are dropped', () => {
    const skill = compileSkill(
      [
        ev({ action: 'click', ref: ref('Edit', 'Search box'), app: 'SearchHost', surface: 'desktop' }),
        ev({ action: 'set_value', ref: ref('Edit', 'Search box'), value: 'notepad', app: 'SearchHost', surface: 'desktop' }),
        ev({ action: 'click', ref: ref('ListItem', 'Notepad, App'), app: 'SearchHost', surface: 'desktop' }),
        ev({ action: 'set_value', ref: ref('Document', 'Text editor'), value: 'coffee 4 euros', app: 'Notepad', surface: 'desktop' }),
      ],
      { name: 'notepad-expenses' },
    );
    expect(skill.steps.map((s) => s.action)).toEqual(['launch_app', 'set_value']);
    expect(skill.steps[0]).toMatchObject({ action: 'launch_app', value: 'notepad', postcondition: { kind: 'window_appeared' } });
    expect(skill.params.map((p) => p.name)).toEqual(['text_editor']);
    expect(skill.app).toBe('Notepad');
    expect(skill.match.processNames).toEqual(['notepad']);
  });

  it('a redacted value typed into Windows search is dropped, not launched', () => {
    const skill = compileSkill(
      [ev({ action: 'set_value', ref: ref('Edit', 'Search box'), value: '{{REDACTED}}', secure: true, app: 'SearchHost' })],
      { name: 'x' },
    );
    expect(skill.steps).toHaveLength(0);
  });

  it('a browser recording compiles to browser steps', () => {
    const skill = compileSkill([ev({ action: 'click', ref: ref('button', 'Compose'), surface: 'browser' })], { name: 'b' });
    expect(skill.steps[0]!.surface).toBe('browser');
  });

  it('derives the app from the recorded process name', () => {
    const skill = compileSkill([ev({ action: 'click', ref: ref('Button', 'OK'), app: 'notepad' })], { name: 'n' });
    expect(skill.app).toBe('notepad');
    expect(skill.match.keywords).toEqual(['notepad']);
  });

  it('skips element interactions that carry no ref instead of emitting an unreplayable step', () => {
    const skill = compileSkill([ev({ action: 'click' }), ev({ action: 'press_keys', value: 'enter' })], { name: 'k' });
    expect(skill.steps.map((s) => s.action)).toEqual(['press_keys']);
  });

  it('dedupes param names from identically-labeled fields', () => {
    const skill = compileSkill(
      [
        ev({ action: 'set_value', ref: ref('textbox', 'Item'), value: 'a' }),
        ev({ action: 'set_value', ref: ref('textbox', 'Item'), value: 'b' }),
      ],
      { name: 'x' },
    );
    expect(skill.params.map((p) => p.name)).toEqual(['item', 'item_2']);
  });
});
