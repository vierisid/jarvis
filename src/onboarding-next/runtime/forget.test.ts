import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, initDatabase } from '../../vault/schema.ts';
import { getSetting, setSetting } from '../../vault/settings.ts';
import { getUserProfile } from '../../vault/user-profile.ts';
import { createCanonicalInterviewProfileStore, createInterviewProfileProvider, createStagedInterviewer } from '../interview-profile/index.ts';
import { createInterviewSessionProvider, createSettingsInterviewStore } from '../interview-session/index.ts';
import type { LLMManager } from '../../llm/manager.ts';
import type { LLMResponse } from '../../llm/provider.ts';
import { forgetUserProfile, FORGOTTEN_ONBOARDING_PREFIXES } from './forget.ts';

const owner = { actorId: 'owner', projectId: 'project' };
const response = (content: string, facts: { theme: string; summary: string }[] = []): LLMResponse => ({ content, model: 'scripted',
  tool_calls: facts.length ? [{ id: 'f', name: 'record_profile_facts', arguments: { facts } }] : [],
  usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'stop' });
let dir: string, answers: (() => Promise<LLMResponse>)[];
const opened = (r: { kind: string; snapshot?: { sessionId: string; turnId: string; phase: string } }) => { if (r.kind !== 'ok' || !r.snapshot) throw Error('not ok'); return r.snapshot; };
function session() {
  return createInterviewSessionProvider({ enabled: true, authorize: () => owner, store: createSettingsInterviewStore(() => getDb()),
    interviewer: createStagedInterviewer({ llmForScope: () => ({ hasConversationTier: () => false,
      chatTier: async () => { const next = answers.shift(); if (!next) throw Error('unexpected inference'); return next(); } }) as unknown as LLMManager }),
    profile: createInterviewProfileProvider({ enabled: true, store: createCanonicalInterviewProfileStore({ owner, database: getDb }) }) });
}
const keys = (prefix: string) => (getDb().query('SELECT key FROM settings WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix) as { key: string }[]).map(r => r.key);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'on-b-11-forget-')); initDatabase(join(dir, 'vault.db'), { quiet: true }); answers = []; });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('Forget removes onboarding interview data, not progress (#1070)', () => {
  test('transcripts, profile receipts and drafted goal plans go; the journey and goal receipt stay', async () => {
    answers = [async () => response('What are you building?', [{ theme: 'work', summary: 'Builds a product' }]),
      async () => response('And your goal?', [{ theme: 'goals', summary: 'Launch a pilot' }])];
    const p = session(), first = opened(await p.request(null, { type: 'start' }));
    await p.request(null, { type: 'answer', sessionId: first.sessionId, turnId: first.turnId, clientRequestId: 'a1', text: 'A pilot.' });
    // Literal on purpose: renaming a prefix must fail here, or rows already on disk would be orphaned.
    const [transcripts, receipts, plans] = ['onboarding-next.interview.v1.', 'onboarding-next.interview-profile.v1.', 'onboarding-next.initial-okr.v1.'];
    expect([...FORGOTTEN_ONBOARDING_PREFIXES]).toEqual([transcripts!, receipts!, plans!]);
    setSetting(`${plans}scope.journey`, JSON.stringify({ digest: 'x', proposal: { objective: { title: 'Launch a pilot' } } }));
    setSetting('onboarding-next.journey.v1.scope', '{"progress":true}');
    setSetting('onboarding-next.initial-goal.v1.scope.journey', '{"goalId":null}');
    setSetting('unrelated.setting', '1');
    expect(keys(transcripts!)).toHaveLength(1); expect(keys(receipts!)).toHaveLength(2); expect(getUserProfile()?.interview_facts).toHaveLength(2);
    forgetUserProfile();
    for (const prefix of FORGOTTEN_ONBOARDING_PREFIXES) expect(keys(prefix)).toEqual([]);
    expect(getUserProfile()).toBeNull();
    expect(getSetting('onboarding-next.journey.v1.scope')).toBe('{"progress":true}');
    expect(getSetting('onboarding-next.initial-goal.v1.scope.journey')).toBe('{"goalId":null}');
    expect(getSetting('unrelated.setting')).toBe('1');
    // A new interview can start afterwards.
    answers = [async () => response('Hello again?')];
    expect(opened(await p.request(null, { type: 'start' })).phase).toBe('ready');
  });
  test('an interview turn in flight during Forget writes nothing back', async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    answers = [async () => response('What are you building?'),
      async () => { entered(); await new Promise<void>(r => { release = r; }); return response('Noted.', [{ theme: 'work', summary: 'Builds a product' }]); }];
    const p = session(), first = opened(await p.request(null, { type: 'start' }));
    const turn = p.request(null, { type: 'answer', sessionId: first.sessionId, turnId: first.turnId, clientRequestId: 'a1', text: 'A product.' });
    await started;
    forgetUserProfile();
    release(); await turn;
    for (const prefix of FORGOTTEN_ONBOARDING_PREFIXES) expect(keys(prefix)).toEqual([]);
    expect(getUserProfile()).toBeNull();
  });
  test('production code reaches clearUserProfile only through forgetUserProfile', () => {
    const root = join(import.meta.dir, '../..'), callers: string[] = [];
    const walk = (d: string) => { for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); }
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && /\bclearUserProfile\b/.test(readFileSync(path, 'utf8'))) callers.push(relative(root, path));
    } };
    walk(root);
    expect(callers.sort()).toEqual(['onboarding-next/runtime/forget.ts', 'vault/user-profile.ts']);
    // And both legacy Forget routes do call it.
    const routes = readFileSync(join(root, 'daemon/api-routes.ts'), 'utf8');
    const handler = (path: string) => routes.slice(routes.indexOf(`'${path}': {`), routes.indexOf('\n    },\n', routes.indexOf(`'${path}': {`)));
    expect(handler('/api/user-profile/clear')).toContain('forgetUserProfile();');
    expect(handler('/api/onboarding/reset')).toMatch(/scope === 'profile'\) \{[^}]*forgetUserProfile\(\);/);
  });
});
