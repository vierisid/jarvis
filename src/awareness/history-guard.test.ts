import { test, expect } from 'bun:test';
import { awarenessHeldLlm, AwarenessHeldError } from './history-guard.ts';
import { setScreenCaptureEnabledSource } from '../actions/tools/desktop-guard.ts';
import { createComposerLlmClient } from '../actions/tools/composer-llm.ts';

test('a retry or fallback inside one held call sends nothing once awareness turns off (#1314 review)', async () => {
  let on = true; const sends: string[] = [];
  setScreenCaptureEnabledSource(() => on);
  try {
    const manager = { async chatTier(_t: unknown, _s: unknown, _m: unknown, options: { checkDeadline?: () => void }) {
      options.checkDeadline?.(); sends.push('provider-a'); on = false; // A fails; awareness turns off during the backoff
      options.checkDeadline?.(); sends.push('provider-b');            // the retry or fallback boundary
      return { content: '{}', usage: {} };
    } };
    const llm = awarenessHeldLlm(createComposerLlmClient(manager as never));
    await expect(llm.chat({ system: 's', prompt: 'evidence' })).rejects.toBeInstanceOf(AwarenessHeldError);
    expect(sends).toEqual(['provider-a']);
  } finally { setScreenCaptureEnabledSource(null); }
});

test('the caller deadline still applies under the hold', async () => {
  const llm = awarenessHeldLlm({ chat: async (input: { checkDeadline?: () => void }) => { input.checkDeadline?.(); return { text: 'ok' }; } });
  await expect(llm.chat({ checkDeadline: () => { throw new Error('deadline'); } })).rejects.toThrow('deadline');
  expect(await llm.chat({})).toEqual({ text: 'ok' });
});

test('the routine composer the daemon builds holds every model call while awareness is off (#1314 review)', async () => {
  const { heldComposition, AwarenessHeldError } = await import('./history-guard.ts');
  const { setScreenCaptureEnabledSource } = await import('../actions/tools/desktop-guard.ts');
  const sent: string[] = [];
  const compose = heldComposition(() => ({ llm: { chat: async (prompt: string) => { sent.push(prompt); return 'ok'; } } }),
    async (deps, request: string) => deps.llm.chat(request));
  try {
    expect(await compose('while on')).toBe('ok');
    setScreenCaptureEnabledSource(() => false);
    await expect(compose('while off')).rejects.toBeInstanceOf(AwarenessHeldError);
    expect(sent).toEqual(['while on']);
  } finally { setScreenCaptureEnabledSource(null); }
  // And the daemon builds the routine composer through it, not around it.
  const daemon = await Bun.file(new URL('../daemon/index.ts', import.meta.url)).text();
  expect(daemon).toContain('new SuggestionComposer(\n          // Every model call of a composition stops once awareness is off (#1314 review).\n          heldComposition(compositionDependencies, composePersistedFlow),');
});

test('the background agent turn is held at its provider retry and fallback boundary too (#1314 follow-up)', async () => {
  const { setScreenCaptureEnabledSource } = await import('../actions/tools/desktop-guard.ts');
  let on = true; const sends: string[] = [];
  setScreenCaptureEnabledSource(() => on);
  try {
    const state = { held: false };
    // LLMManager.chatTier(tier, subsystem, messages, options) asks options.checkDeadline before each provider attempt.
    const llm = awarenessHeldLlm({ async chatTier(_tier: string, _subsystem: string, _messages: unknown[], options?: { checkDeadline?: () => void; tools?: unknown[] }) {
      options?.checkDeadline?.(); sends.push(`a:${options?.tools?.length}`); on = false; options?.checkDeadline?.(); sends.push('b'); return {}; } }, state);
    await expect(llm.chatTier('medium', 'chat_orchestrator', [], { tools: [1] })).rejects.toBeInstanceOf(AwarenessHeldError);
    // The caller's options are kept; only the deadline hook is added.
    expect(sends).toEqual(['a:1']); expect(state.held).toBe(true);
  } finally { setScreenCaptureEnabledSource(null); }
});
