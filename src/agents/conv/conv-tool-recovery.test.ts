import { describe, expect, it } from 'bun:test';
import { couldStartWithSerializedConvTool, recoverSerializedConvTools } from './conv-tool-recovery.ts';

describe('conversation text tool recovery', () => {
  it('buffers partial internal prefixes without delaying ordinary prose', () => {
    expect(couldStartWithSerializedConvTool('F')).toBe(true);
    expect(couldStartWithSerializedConvTool('FALLBACK_OK/dele')).toBe(true);
    expect(couldStartWithSerializedConvTool('/delegate')).toBe(true);
    expect(couldStartWithSerializedConvTool('(dele')).toBe(true);
    expect(couldStartWithSerializedConvTool('Hi again')).toBe(false);
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
});
