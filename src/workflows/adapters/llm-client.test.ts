import { expect, test } from 'bun:test';
import { LLMManager } from '../../llm/manager';
import { LLMProviderError, type LLMProvider } from '../../llm/provider';
import { failureEvidence } from '../../failures/evidence';
import { failureText, projectFailure } from '../../failures/projection';
import { JarvisLlmClient } from './llm-client';

test('an Ask step gets one overall deadline instead of three full provider attempts', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'fixture',
    chat(_messages, options) {
      calls++;
      // A provider that took the connection and never answers; it only stops when aborted.
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason)));
    },
    async *stream() {}, async listModels() { return []; },
  };
  const manager = new LLMManager();
  manager.registerProvider(provider);
  const started = Date.now();
  const error = await new JarvisLlmClient(manager, 50).chat({ prompt: 'hi' }).catch(e => e);
  expect(Date.now() - started).toBeLessThan(1500);
  expect(calls).toBe(1);
  expect(error).toBeInstanceOf(LLMProviderError);
  const text = failureText(projectFailure(failureEvidence(error), { label: 'The Ask step', sideEffects: false }));
  expect(text).toContain('did not answer in time');
  expect(text).not.toContain('could not be reached');
});

test('a prompt answered inside the deadline is returned', async () => {
  const manager = new LLMManager();
  manager.registerProvider({ name: 'fixture', async chat() {
    return { content: 'done', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'm', finish_reason: 'stop' as const };
  }, async *stream() {}, async listModels() { return []; } });
  expect((await new JarvisLlmClient(manager, 500).chat({ prompt: 'hi' })).text).toBe('done');
});
