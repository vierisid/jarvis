import { describe, expect, it } from 'bun:test';
import { compileSkill } from './compiler.ts';
import { redactInteraction, looksSecret, SkillRecorder, type RawInteraction } from './recorder.ts';
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

  it('SkillRecorder buffers redacted interactions', () => {
    const rec = new SkillRecorder();
    rec.start('s1', 1000);
    rec.push(ev({ action: 'set_value', ref: ref('textbox', 'Password'), value: 'secret!' }));
    rec.push(ev({ action: 'click', ref: ref('button', 'Login') }));
    const session = rec.stop();
    expect(session!.interactions).toHaveLength(2);
    expect(session!.interactions[0]!.value).toBe('{{REDACTED}}');
    expect(rec.isRecording()).toBe(false);
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

  it('parameterizes typed values and names params from field labels', () => {
    const skill = compileSkill(
      [
        ev({ action: 'set_value', ref: ref('textbox', 'Subject'), value: 'Hi there' }),
        ev({ action: 'set_value', ref: ref('textbox', 'Message Body'), value: 'body text' }),
      ],
      { name: 'compose' },
    );
    expect(skill.params.map((p) => p.name)).toEqual(['subject', 'message_body']);
    expect(skill.steps[0]!.value).toBe('{{subject}}');
    expect(skill.steps[0]!.postcondition).toEqual({ kind: 'value_equals', value: '{{subject}}' });
  });

  it('turns a redacted secret into a param with NO value_equals postcondition', () => {
    const skill = compileSkill(
      [ev({ action: 'set_value', ref: ref('textbox', 'Password'), value: '{{REDACTED}}' })],
      { name: 'login' },
    );
    expect(skill.params).toHaveLength(1);
    expect(skill.steps[0]!.postcondition).toBeUndefined(); // masked field won't read back
  });

  it('gives a terminal click a title_changed postcondition and derives domains', () => {
    const skill = compileSkill(
      [
        ev({ action: 'set_value', ref: ref('textbox', 'To'), value: 'a@b.com', url: 'https://mail.google.com/x' }),
        ev({ action: 'click', ref: ref('button', 'Send'), url: 'https://mail.google.com/x' }),
      ],
      { name: 'gmail', app: 'Gmail' },
    );
    const send = skill.steps[skill.steps.length - 1]!;
    expect(send.action).toBe('click');
    expect(send.postcondition).toEqual({ kind: 'title_changed' });
    expect(skill.match.domains).toContain('mail.google.com');
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
