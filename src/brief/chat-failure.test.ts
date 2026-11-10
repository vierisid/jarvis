import { expect, test } from 'bun:test';
import { LLMProviderError } from '../llm/provider';
import { briefChatFailure } from './chat-failure';

test('thrown provider failures preserve classification without exposing their body', () => {
  const failure = briefChatFailure(new LLMProviderError('private-key and prompt', 'auth'), false);
  expect(failure.code).toBe('provider_auth');
  expect(failure.message).toContain('credentials');
  expect(failure.message).not.toContain('private-key');
});
test('untyped errors are never blamed on the provider and unknown codes remain generic', () => {
  // A speech provider failure after the answer must not send the user to the AI settings.
  const tts = briefChatFailure(new Error('ElevenLabs TTS error (401): Unauthorized'), false);
  expect(tts).toEqual({ code: 'generation_failed', message: 'This response could not finish. You can send a new message to try again.' });
  expect(briefChatFailure(new Error('HTTP 429 secret'), false).code).toBe('generation_failed');
  expect(briefChatFailure(new LLMProviderError('HTTP 429 secret', 'rate_limit'), false).code).toBe('provider_rate_limit');
  expect(briefChatFailure(new LLMProviderError('secret', 'invalid' as never), false).code).toBe('generation_failed');
  expect(briefChatFailure(new Error('secret'), true).message).toContain('Check what earlier actions did');
});
