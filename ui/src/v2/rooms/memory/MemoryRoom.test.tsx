import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb } from '../../../../../src/vault/schema';
import { createEntity, findEntities } from '../../../../../src/vault/entities';
import { createFact, findFacts, getFact, queryFact } from '../../../../../src/vault/facts';
import { getKnowledgeForMessage } from '../../../../../src/vault/retrieval';
import { createFactDecisionRoutes } from '../../../../../src/vault/fact-routes';
import { getUserProfile, saveUserProfile } from '../../../../../src/vault/user-profile';
import { formatUserProfileForPrompt } from '../../../../../src/user/profile';

const NativeRequest = globalThis.Request, NativeResponse = globalThis.Response, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let MemoryRoomBody: typeof import('./MemoryRoom').MemoryRoomBody;
let root: ReturnType<typeof createRoot> | null, host: HTMLDivElement;
let directory: string, path: string, subject: string, oldId: string;
let failSave = false, loseResponse = false;
beforeAll(async () => {
  ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client'));
  ({ MemoryRoomBody } = await import('./MemoryRoom'));
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-memory-ui-')); path = join(directory, 'vault.db');
  initDatabase(path); subject = createEntity('person', 'Alex').id;
  oldId = createFact(subject, 'preferred_editor', 'Vim', { confidence: 0.7, source: 'llm_extraction' }).id;
  failSave = false; loseResponse = false;
  const routes = createFactDecisionRoutes();
  globalThis.fetch = (async (input, opts = {}) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/vault/entities') return NativeResponse.json(findEntities({}));
    if (url.pathname === '/api/vault/relationships') return NativeResponse.json([]);
    if (url.pathname === '/api/vault/facts') return NativeResponse.json(findFacts({
      subject_id: url.searchParams.get('subject_id') ?? undefined, includeSuperseded: url.searchParams.get('include_superseded') === 'true',
    }));
    const match = url.pathname.match(/^\/api\/vault\/facts\/([^/]+)\/(confirm|correct)$/);
    if (match) {
      if (failSave) return NativeResponse.json({ error: 'Save unavailable' }, { status: 500 });
      const request = Object.assign(new NativeRequest(url, { method: 'POST', body: opts.body }), { params: { id: match[1]! } });
      const route = match[2] === 'confirm' ? routes['/api/vault/facts/:id/confirm'] : routes['/api/vault/facts/:id/correct'];
      const result = await route.POST(request);
      if (loseResponse) { loseResponse = false; throw new Error('Response lost. Please retry.'); }
      return result;
    }
    return NativeResponse.json({}, { status: 404 });
  }) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = null; host?.remove();
  globalThis.fetch = originalFetch; closeDb(); rmSync(directory, { recursive: true, force: true });
});
afterAll(() => GlobalRegistrator.unregister());
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label}: ${host.textContent}`); return found;
}
async function mount(name = 'Alex') {
  if (root) { await act(async () => root!.unmount()); host.remove(); }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<MemoryRoomBody mode="expanded" />));
  await act(async () => button('Browser').click());
  const entity = [...host.querySelectorAll('button')].find(b => b.classList.contains('v2-mem__col-row') && b.textContent?.includes(name))!;
  await act(async () => entity.click());
}
async function submit() {
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

test('active Memory room corrects a fact, changes the next recall and recovers history after restart', async () => {
  await mount(); expect(host.textContent).toContain('inferred · active · 70%');
  await act(async () => button('Correct fact').click());
  (host.querySelector('[name="object"]') as HTMLTextAreaElement).value = 'Zed';
  (host.querySelector('[name="reason"]') as HTMLTextAreaElement).value = 'Current editor confirmed';
  await submit(); expect(host.textContent).toContain('confirmed · active');
  expect(getKnowledgeForMessage('Alex editor')).toContain('preferred_editor: Zed');
  expect(getKnowledgeForMessage('Alex editor')).not.toContain('preferred_editor: Vim');
  closeDb(); initDatabase(path); await mount();
  expect(host.textContent).toContain('Zed');
  await act(async () => button('Earlier values').click());
  expect(host.textContent).toContain('Vim · superseded'); expect(getFact(oldId)?.status).toBe('superseded');
});

test('confirmation is explicit, preserves source evidence and makes a unique value usable', async () => {
  await mount(); await act(async () => button('Confirm fact').click());
  expect(queryFact('Alex', 'preferred_editor')).toBeNull();
  (host.querySelector('[name="reason"]') as HTMLTextAreaElement).value = 'Checked with Alex';
  await submit(); expect(queryFact('Alex', 'preferred_editor')?.id).toBe(oldId);
  expect(getFact(oldId)?.evidence.map(e => e.source)).toContain('llm_extraction');
  expect(host.textContent).toContain('Checked with Alex');
});

test('failed or uncertain correction retains input and retry produces one replacement', async () => {
  await mount(); await act(async () => button('Correct fact').click());
  (host.querySelector('[name="object"]') as HTMLTextAreaElement).value = 'Zed';
  (host.querySelector('[name="reason"]') as HTMLTextAreaElement).value = 'Correcting the editor';
  failSave = true; await submit(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('Save unavailable');
  expect((host.querySelector('[name="object"]') as HTMLTextAreaElement).value).toBe('Zed');
  failSave = false; loseResponse = true; await submit(); expect(host.textContent).toContain('Response lost');
  await submit(); expect(findFacts({ subject_id: subject })).toHaveLength(1);
  expect(findFacts({ subject_id: subject, includeSuperseded: true })).toHaveLength(2);
  expect(host.textContent).toContain('confirmed · active');
});

test('Memory profile correction updates agent profile context and survives restart and a later profile save', async () => {
  saveUserProfile({ preferred_name: 'Jamie', interests: 'Chemistry' });
  await mount('Jamie');
  const row = [...host.querySelectorAll('.v2-mem__fact')].find(el => el.querySelector('.v2-mem__fact-pred')?.textContent === 'preferred_name')!;
  const correct = [...row.querySelectorAll('button')].find(b => b.textContent === 'Correct fact')!;
  await act(async () => correct.click());
  (host.querySelector('[name="object"]') as HTMLTextAreaElement).value = 'Sam';
  (host.querySelector('[name="reason"]') as HTMLTextAreaElement).value = 'Call me Sam';
  await submit();
  expect(getUserProfile()?.answers.preferred_name).toBe('Sam');
  expect(formatUserProfileForPrompt(getUserProfile())).not.toContain('Jamie');
  closeDb(); initDatabase(path);
  saveUserProfile({ ...getUserProfile()!.answers, interests: 'Engineering' });
  await mount('Sam');
  expect(queryFact('Sam', 'preferred_name')?.object).toBe('Sam');
  expect(queryFact('Sam', 'name')?.object).toBe('Sam');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
