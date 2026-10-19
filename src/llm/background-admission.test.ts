import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BACKGROUND_LIMITS, BackgroundBudget, runWithAdmission, setBackgroundBudget } from './background-budget';
import { LLMManager } from './manager';
import { runWithOrigin } from './origin';
import type { LLMProvider, LLMResponse } from './provider';
import { BackgroundAgentService } from '../daemon/background-agent-service';
import { CommitmentExecutor } from '../daemon/commitment-executor';
import { createApiRoutes, type ApiContext } from '../daemon/api-routes';
import { GoalService } from '../goals/service';
import { closeDb, initDatabase } from '../vault/schema';
import { createCommitment, getCommitment } from '../vault/commitments';
import type { GoalConfig, JarvisConfig } from '../config/types';

/**
 * Admission exemptions (owner decision on #1064): user-scheduled, run-once work
 * (commitment execution, the daily morning/evening rhythm) is never refused or
 * metered by the background budget, and a clicked weekly report is foreground.
 * The origin stays `background` for hosted screening in every case.
 */

const databases: Database[] = [];
afterEach(() => {
  setBackgroundBudget(null);
  for (const db of databases.splice(0)) db.close();
  try { closeDb(); } catch { /* not opened by this test */ }
});

const messages = [{ role: 'user' as const, content: 'Synthetic fixture' }];
const reply: LLMResponse = { content: 'ok', tool_calls: [], model: 'fixture', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };

/** A governor whose rolling allowance is already spent (daily_budget). */
function exhausted() {
  const db = new Database(':memory:'); databases.push(db);
  const budget = new BackgroundBudget(() => db, { ...BACKGROUND_LIMITS, requests: 0 });
  setBackgroundBudget(budget);
  return budget;
}

/** A manager whose provider records the origin of each call; `hold` parks user calls. */
function fixture(hold?: Promise<void>) {
  const seen: string[] = [];
  const m = new LLMManager();
  m.registerProvider({
    name: 'fixture',
    async chat(_messages, _options) {
      const { currentOrigin } = await import('./origin');
      seen.push(currentOrigin() ?? 'unset');
      if (hold && currentOrigin() === 'user') await hold;
      return reply;
    },
    async *stream() { seen.push('stream'); yield { type: 'done', response: reply }; },
    listModels: async () => [],
  } as LLMProvider);
  m.setTierMap({ medium: { provider: 'fixture' } });
  return { m, seen };
}

/** Holds one user call in flight on its own manager, so the governor reports foreground_busy. */
async function foregroundInFlight(budget: BackgroundBudget) {
  let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  const { m } = fixture(hold);
  const done = runWithOrigin('user', () => m.chatTier('medium', 'chat', messages));
  for (let i = 0; i < 20 && budget.snapshot().foreground === 0; i++) await Promise.resolve();
  expect(budget.snapshot().foreground).toBe(1);
  return async () => { release(); await done; };
}

test('exempt background calls bypass an exhausted budget and a busy foreground, and spend no allowance', async () => {
  const budget = exhausted();
  const { m, seen } = fixture();
  // Control: the same call without the exemption is refused.
  await expect(runWithOrigin('background', () => m.chatTier('medium', 'bg', messages))).rejects.toMatchObject({ code: 'background_throttled' });
  const finishUser = await foregroundInFlight(budget);
  expect(budget.snapshot().reason).toBe('foreground_busy');
  await runWithAdmission('exempt', () => runWithOrigin('background', () => m.chatTier('medium', 'commitment', messages)));
  await runWithAdmission('exempt', () => runWithOrigin('background', async () => {
    for await (const _ of m.streamTier('medium', 'rhythm', messages)) { /* consume */ }
  }));
  await finishUser();
  expect(seen).toEqual(['background', 'stream']);
  expect(budget.snapshot()).toMatchObject({ foreground: 0, active: 0, usage: { requests: 0, outputTokens: 0 } });
});

test('foreground admission is not refused and holds off new background starts', async () => {
  const budget = exhausted();
  let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  const m = new LLMManager();
  m.registerProvider({ name: 'fixture', chat: async () => { await hold; return reply; },
    stream: async function* () { yield { type: 'done', response: reply }; }, listModels: async () => [] } as LLMProvider);
  m.setTierMap({ medium: { provider: 'fixture' } });
  const report = runWithAdmission('foreground', () => runWithOrigin('background', () => m.chatTier('medium', 'report', messages)));
  await Promise.resolve(); await Promise.resolve();
  expect(budget.snapshot()).toMatchObject({ foreground: 1, reason: 'foreground_busy' });
  release(); await report;
  expect(budget.snapshot().usage.requests).toBe(0);
});

function backgroundAgent(processMessage: () => Promise<string>) {
  const svc = new BackgroundAgentService({} as JarvisConfig, {} as LLMManager);
  (svc as unknown as { orchestrator: { processMessage: () => Promise<string> } }).orchestrator = { processMessage };
  return svc;
}

async function fire(executor: CommitmentExecutor, id: string, what: string) {
  const internals = executor as unknown as { pending: Map<string, unknown>; fireExecution(id: string): Promise<void> };
  internals.pending.set(id, { commitmentId: id, what, announcedAt: 0, cancelDeadline: 0, cancelled: false, executed: false });
  await internals.fireExecution(id);
}

test('a due commitment runs while the daily budget is exhausted and while a foreground call is in flight', async () => {
  initDatabase(':memory:', { quiet: true });
  const budget = exhausted();
  const { m, seen } = fixture();
  const finishUser = await foregroundInFlight(budget);
  const executor = new CommitmentExecutor('aggressive');
  executor.setAgentService(backgroundAgent(async () => (await m.chatTier('medium', 'commitment', messages)).content));
  const commitment = createCommitment('fixture task', { when_due: Date.now() - 1000 });
  await fire(executor, commitment.id, commitment.what);
  await finishUser();
  expect(getCommitment(commitment.id)).toMatchObject({ status: 'completed', result: 'ok' });
  expect(seen).toEqual(['background']);
});

test('a turn queued behind an exempt commitment does not inherit the exemption', async () => {
  exhausted();
  const { m } = fixture();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let turn = 0;
  const svc = backgroundAgent(async () => {
    if (turn++ === 0) await gate;
    return (await m.chatTier('medium', 'bg', messages)).content;
  });
  const commitment = runWithAdmission('exempt', () => svc.handleMessage('commitment', 'system'));
  const reaction = svc.handleMessage('reaction', 'awareness');
  release();
  expect(await commitment).toBe('ok');
  await expect(reaction).rejects.toMatchObject({ code: 'background_throttled' });
});

test('the daily rhythm runs while the budget is exhausted and a foreground call is in flight', async () => {
  initDatabase(':memory:', { quiet: true });
  const budget = exhausted();
  const { m } = fixture();
  const finishUser = await foregroundInFlight(budget);
  const service = new GoalService({} as GoalConfig);
  const posted: string[] = [];
  service.setChatCallback(text => posted.push(text));
  const plan = async () => ({ message: (await m.chatTier('medium', 'rhythm', messages)).content, warnings: [], focusAreas: [], dailyActions: [] });
  (service as unknown as { rhythm: unknown }).rhythm = { runMorningPlan: plan, runEveningReview: plan };
  await (service as unknown as { fireRhythm(kind: 'morning'): Promise<void> }).fireRhythm('morning');
  await finishUser();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain('ok');
});

test('a clicked weekly report is foreground and is not refused by an exhausted budget', async () => {
  const budget = exhausted();
  const { m, seen } = fixture();
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} } } as unknown as JarvisConfig,
    awarenessService: { generateWeeklyReport: async () => ({ summary: (await m.chatTier('medium', 'awareness_weekly', messages)).content }) },
  } as unknown as ApiContext);
  const route = routes['/api/awareness/report/weekly'] as { GET(req: Request): Promise<Response> };
  const res = await route.GET(new Request('http://localhost/api/awareness/report/weekly'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ summary: 'ok' });
  expect(seen).toEqual(['background']);
  expect(budget.snapshot().usage.requests).toBe(0);
});
