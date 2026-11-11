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

// #1312 follow-up: the hosted provider's own sentence for this account (when
// usage resumes, where to appeal) reaches Brief chat; the raw body never does.
test('a hosted failure keeps its authored detail, and its next step fits what happened', () => {
  const restricted = briefChatFailure(new LLMProviderError('Usejarvis AI API error (401): raw', 'restricted', undefined, undefined,
    'Usejarvis AI is restricted on this account for a usage-policy violation. To appeal, contact appeals@x.example.'), false);
  expect(restricted.code).toBe('provider_restricted');
  expect(restricted.message).toContain('To appeal, contact appeals@x.example.');
  // One place to appeal: the generic "contact support" step would name a second.
  expect(restricted.message).not.toContain('Contact support');
  expect(restricted.message).toContain('use your own AI provider');
  // Without the detail the generic step stands.
  expect(briefChatFailure(new LLMProviderError('x', 'restricted'), false).message).toContain('Contact support to appeal');
  expect(restricted.message).not.toContain('Wait for the limit to reset');

  const blocked = briefChatFailure(new LLMProviderError('x', 'content_policy', undefined, undefined, 'This request was blocked by the Usejarvis AI content policy and was not processed.'), false);
  expect(blocked.message).toContain('Change what it asks');
  expect(blocked.message).not.toContain('Wait for the limit to reset');

  const quota = briefChatFailure(new LLMProviderError('x', 'quota_exhausted', undefined, undefined, 'Your included AI usage is used up for this window (resumes 13:05 UTC).'), false);
  expect(quota.message).toContain('resumes 13:05 UTC');

  const model = briefChatFailure(new LLMProviderError('x', 'forbidden', undefined, undefined, 'That model is not included in your plan.'), false);
  expect(model).toMatchObject({ code: 'provider_forbidden' });
  expect(model.message).toContain('That model is not included in your plan. Nothing was done. Choose another model');
  expect(model.message).not.toContain('Wait for the limit');

  // No active hosted plan is not an AI-settings credential problem.
  const inactive = briefChatFailure(new LLMProviderError('x', 'auth', undefined, undefined, 'Usejarvis AI is not active on this account - an active plan is required.'), false);
  expect(inactive.code).toBe('provider_plan_inactive');
  expect(inactive.message).toContain('an active plan is required');
  expect(inactive.message).not.toContain('Reconnect');
});

test('without hosted detail nothing extra is added, and the detail is bounded and redacted', () => {
  expect(briefChatFailure(new LLMProviderError('raw body', 'restricted'), false).message).not.toContain('raw body');
  const long = briefChatFailure(new LLMProviderError('x', 'restricted', undefined, undefined, `To appeal, contact ${'a'.repeat(5000)}`), false);
  expect(long.message.length).toBeLessThan(1600);
});

test('a turn Jarvis stopped for looping on tools says so and asks to check the steps', () => {
  const failure = briefChatFailure(new LLMProviderError('I stopped after 50 steps', 'tool_loop_limit'), true);
  expect(failure.code).toBe('tool_loop_limit');
  expect(failure.message).toContain('stopped after too many steps');
  expect(failure.message).not.toContain('provider');
});
