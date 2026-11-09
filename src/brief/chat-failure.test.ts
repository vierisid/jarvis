import { expect, test } from 'bun:test';
import { LLMProviderError } from '../llm/provider';
import { briefChatFailure } from './chat-failure';

test('thrown provider failures preserve classification without exposing their body', () => {
  const failure = briefChatFailure(new LLMProviderError('private-key and prompt', 'auth'), false);
  expect(failure.code).toBe('provider_auth');
  expect(failure.message).toContain('credentials');
  expect(failure.message).not.toContain('private-key');
});
test('untyped HTTP errors use existing classification and unknown codes remain generic', () => {
  expect(briefChatFailure(new Error('HTTP 429 secret'), false).code).toBe('provider_rate_limit');
  expect(briefChatFailure(new LLMProviderError('secret', 'invalid' as never), false).code).toBe('generation_failed');
  expect(briefChatFailure(new Error('secret'), true).message).toContain('Check what earlier actions did');
});
