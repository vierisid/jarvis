import { expect, test } from 'bun:test';
import { BriefCapabilities } from '../capabilities';
import type { BriefProvider } from '../providers';
import { registerChatState } from './chat-state';

test('chat state remains default off and requires both live dependencies plus explicit activation', () => {
  let state: ReturnType<BriefProvider['readiness']> = 'ready';
  const provider: BriefProvider = { readiness: () => state };
  const registrations = [{ id: 'conversations' as const, provider }, { id: 'chatTransport' as const, provider }, ...registerChatState(provider, provider)];
  expect(new BriefCapabilities(registrations).snapshot().capabilities.chatState).toMatchObject({ supported: true, ready: true, enabled: false, reason: 'disabled' });
  expect(new BriefCapabilities(registrations, ['chatState']).snapshot().capabilities.chatState.reason).toBe('dependency_not_ready');
  const enabled = new BriefCapabilities(registrations, ['conversations', 'chatTransport', 'chatState']);
  expect(enabled.snapshot().capabilities.chatState.enabled).toBe(true);
  state = 'loading'; expect(enabled.snapshot().capabilities.chatState.state).toBe('loading');
  state = 'unavailable'; expect(enabled.snapshot().capabilities.chatState.enabled).toBe(false);
});
