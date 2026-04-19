import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { IntentEvaluator } from './evaluator.ts';

describe('IntentEvaluator', () => {
  let manager: any;
  let router: any;

  beforeEach(() => {
    manager = {
      chat: mock(async () => ({ content: 'SIMPLE' }))
    };
    router = {
      getCheapestAvailable: mock(() => 'ollama')
    };
  });

  test('identifies complexity from heuristics', async () => {
    const evaluator = new IntentEvaluator(manager, router);
    const result = await evaluator.evaluate('Can you refactor this python script?');
    expect(result).toBe('COMPLEX');
    expect(manager.chat).toHaveBeenCalledTimes(0); // Bypassed
  });

  test('identifies simplicity from heuristics', async () => {
    // There are no simplicity heuristics, it goes to LLM
    const evaluator = new IntentEvaluator(manager, router);
    const result = await evaluator.evaluate('How are you today?');
    expect(result).toBe('SIMPLE');
    expect(manager.chat).toHaveBeenCalledTimes(1);
  });

  test('handles LLM classification "COMPLEX"', async () => {
    manager.chat = mock(async () => ({ content: 'COMPLEX' }));
    const evaluator = new IntentEvaluator(manager, router);
    const result = await evaluator.evaluate('Think step by step about the future of AI');
    expect(result).toBe('COMPLEX');
    expect(manager.chat).toHaveBeenCalledTimes(1);
  });

  test('defaults to SIMPLE on LLM error', async () => {
    manager.chat = mock(async () => { throw new Error('API down'); });
    const evaluator = new IntentEvaluator(manager, router);
    const result = await evaluator.evaluate('Something random');
    expect(result).toBe('SIMPLE');
  });
});
