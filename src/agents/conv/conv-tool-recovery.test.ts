import { describe, expect, it } from 'bun:test';
import {
  pendingSerializedToolSuffix,
  recoverSerializedConvTools,
  visibleStreamText as visibleWhileStreaming,
} from './conv-tool-recovery.ts';

describe('conversation text tool recovery', () => {
  it('withholds partial internal prefixes without delaying ordinary prose', () => {
    expect(pendingSerializedToolSuffix('F')).toBe(1);
    // Only `/dele` is ambiguous — the complete marker before it is stripped
    // outright, so it never needs withholding.
    expect(pendingSerializedToolSuffix('FALLBACK_OK/dele')).toBe(5);
    expect(visibleWhileStreaming('FALLBACK_OK/dele')).toBe('');
    expect(pendingSerializedToolSuffix('/delegate')).toBe(9);
    expect(pendingSerializedToolSuffix('(dele')).toBe(5);
    expect(pendingSerializedToolSuffix('Hi again')).toBe(0);
    // Prose that merely starts like a marker must not be held once it can no
    // longer become one.
    expect(pendingSerializedToolSuffix('Fantastic news')).toBe(0);
    expect(pendingSerializedToolSuffix('/delegated the work')).toBe(0);
  });

  it('withholds a serialized call that begins mid-response', () => {
    const text = 'Sure, let me look into that. /delegate{"tier":"medium"';
    expect(pendingSerializedToolSuffix(text)).toBe(text.length - 'Sure, let me look into that. '.length);
    expect(visibleWhileStreaming(text)).toBe('Sure, let me look into that. ');
  });

  it('withholds an unresolved call that precedes a resolved one', () => {
    // The inner `/check_task` sits inside the outer call's unfinished JSON.
    const text = '/delegate{"intent":"run /check_task{\\"a\\":1} later"';
    expect(pendingSerializedToolSuffix(text)).toBe(text.length);
    expect(visibleWhileStreaming(text)).toBe('');
  });

  it('withholds the paren form until its closing parenthesis arrives', () => {
    const text = 'On it. (delegate {"tier":"medium","template":"code","intent":"x"}';
    expect(pendingSerializedToolSuffix(text)).toBe(text.length - 'On it. '.length);
    expect(visibleWhileStreaming(`${text})`)).toBe('On it. ');
  });

  it('recovers a leaked delegate call and keeps only visible prose', () => {
    const recovered = recoverSerializedConvTools(
      'FALLBACK_OK/delegate{"intent":"Provide friendly greeting.","template":"general","tier":"medium"} Hi again, how is your day going?',
      [],
      'test',
    );

    expect(recovered.text).toBe('Hi again, how is your day going?');
    expect(recovered.toolCalls).toEqual([{
      id: 'test_0',
      name: 'delegate',
      arguments: {
        intent: 'Provide friendly greeting.',
        template: 'general',
        tier: 'medium',
      },
    }]);
  });

  it('recovers the parenthesized tool syntax without exposing it to TTS', () => {
    const recovered = recoverSerializedConvTools(
      '(delegate {"intent":"Check the last email in my inbox","template":"research","tier":"medium"}) Let me check your inbox now.',
      [],
      'test',
    );

    expect(recovered.text).toBe('Let me check your inbox now.');
    expect(recovered.toolCalls).toEqual([{
      id: 'test_0',
      name: 'delegate',
      arguments: {
        intent: 'Check the last email in my inbox',
        template: 'research',
        tier: 'medium',
      },
    }]);
  });

  it('closes the seam when a call is removed from the middle of prose', () => {
    const recovered = recoverSerializedConvTools(
      'Checking now. /delegate{"tier":"medium","template":"code","intent":"x"} Back shortly.',
      [],
      'test',
    );
    expect(recovered.text).toBe('Checking now. Back shortly.');
    expect(recovered.toolCalls).toHaveLength(1);
  });

  it('does not re-emit JSON from a marker nested inside a recovered call', () => {
    const recovered = recoverSerializedConvTools(
      '/delegate{"tier":"medium","template":"code","intent":"run /check_task{\\"task_id\\":\\"t1\\"} first"} On it.',
      [],
      'test',
    );
    expect(recovered.text).toBe('On it.');
    expect(recovered.toolCalls).toHaveLength(1);
    expect(recovered.toolCalls[0]?.name).toBe('delegate');
  });

  it('does not duplicate a structured call also printed in text', () => {
    const existing = {
      id: 'structured',
      name: 'check_task',
      arguments: { task_id: 'task-1' },
    };
    const recovered = recoverSerializedConvTools(
      '/check_task{"task_id":"task-1"}',
      [existing],
      'test',
    );

    expect(recovered.text).toBe('');
    expect(recovered.toolCalls).toEqual([existing]);
  });

  it('handles braces and escaped quotes inside JSON strings', () => {
    const recovered = recoverSerializedConvTools(
      '/delegate{"tier":"medium","template":"general","intent":"Explain {this} and \\"that\\""} Working on it.',
      [],
      'test',
    );
    expect(recovered.text).toBe('Working on it.');
    expect(recovered.toolCalls[0]?.arguments.intent).toBe('Explain {this} and "that"');
  });

  it('leaves an unparseable call visible rather than swallowing the turn', () => {
    const recovered = recoverSerializedConvTools('/delegate{not json} Hi.', [], 'test');
    expect(recovered.text).toBe('/delegate{not json} Hi.');
    expect(recovered.toolCalls).toEqual([]);
  });

  it('streams a growing buffer monotonically', () => {
    // Whatever order the chunks arrive in, the visible text only ever extends —
    // otherwise a streaming caller would have to un-say something.
    const full = 'Sure. /delegate{"tier":"medium","template":"code","intent":"x"} Done.';
    let previous = '';
    for (let length = 1; length <= full.length; length++) {
      const visible = visibleWhileStreaming(full.slice(0, length));
      expect(visible.startsWith(previous)).toBe(true);
      previous = visible;
    }
    expect(previous).toBe('Sure. Done.');
  });
});
