/** Q-20 synthetic resource envelope. No credentials, network or external effects. */
import { cpus, totalmem, platform, arch, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BackgroundBudget, BACKGROUND_LIMITS, setBackgroundBudget } from '../src/llm/background-budget';
import { LLMManager } from '../src/llm/manager';
import { currentOrigin, runWithOrigin } from '../src/llm/origin';
import type { LLMProvider, LLMResponse } from '../src/llm/provider';
import { initDatabase, closeDb } from '../src/vault/schema';
import { ApprovalManager } from '../src/authority/approval';

const directory = mkdtempSync(join(tmpdir(), 'q20-measure-'));
const db = initDatabase(join(directory, 'fixture.db'), { quiet: true });
const messages = [{ role: 'user' as const, content: 'Synthetic eligible capture. '.repeat(100) }];
const response: LLMResponse = { content: 'fixture', model: 'fixture-40ms', tool_calls: [], finish_reason: 'stop', usage: { input_tokens: 100, output_tokens: 20 } };
const originalError = console.error;
let diagnostics = 0;
console.error = () => { diagnostics++; };
async function scenario(enabled: boolean, burst: number) {
  db.run('DELETE FROM background_model_reservations');
  db.run('DELETE FROM background_model_backoff');
  const budget = new BackgroundBudget(() => db);
  setBackgroundBudget(enabled ? budget : null);
  let providerCalls = 0, active = 0, maxActive = 0, foregroundCalls = 0;
  const manager = new LLMManager();
  manager.registerProvider({ name: 'fixture', listModels: async () => [], async chat(_messages, options) {
    const background = currentOrigin() === 'background';
    if (background) { providerCalls++; active++; maxActive = Math.max(active, maxActive); } else foregroundCalls++;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 40);
        options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal!.reason); }, { once: true });
      });
      return response;
    } finally { if (background) active--; }
  }, async *stream() { yield { type: 'done', response }; } } satisfies LLMProvider);
  manager.setTierMap({ medium: { provider: 'fixture' } });
  const approval = new ApprovalManager();
  const request = approval.createRequest({ agentId: 'fixture', agentName: 'fixture', toolName: 'fixture', toolArguments: {}, actionCategory: 'write_data', urgency: 'normal', reason: 'fixture', context: 'synthetic' });
  const started = performance.now(), cpu = process.cpuUsage(), memory = process.memoryUsage();
  let maxRss = memory.rss, maxHeap = memory.heapUsed;
  const sampler = setInterval(() => { const m = process.memoryUsage(); maxRss = Math.max(maxRss, m.rss); maxHeap = Math.max(maxHeap, m.heapUsed); }, 1);
  const controlLatencies: number[] = [];
  const control = new Promise<void>(resolve => setTimeout(() => {
    const before = performance.now();
    if (approval.deny(request.id, 'fixture')?.status !== 'denied') throw new Error('Approval decision failed');
    controlLatencies.push(performance.now() - started, performance.now() - before); resolve();
  }, 0));
  const background = Array.from({ length: burst }, () => runWithOrigin('background', () => manager.chatTier('medium', 'capture_fixture', messages)));
  const backgroundSettled = Promise.allSettled(background);
  const cancel = new AbortController();
  const foregroundStart = performance.now();
  const conversations = burst ? runWithOrigin('user', () => Promise.allSettled([
    manager.chatTier('medium', 'conversation_a', messages),
    manager.chatTier('medium', 'conversation_b', messages, { signal: cancel.signal }),
  ])) : Promise.resolve([]);
  const cancelStart = performance.now(); cancel.abort();
  const cancellationSignalMs = performance.now() - cancelStart;
  const foreground = await conversations;
  const foregroundMs = performance.now() - foregroundStart;
  const results = await backgroundSettled;
  await control; await new Promise(resolve => setTimeout(resolve, 250)); clearInterval(sampler);
  const cpuSpent = process.cpuUsage(cpu);
  const record = { governor: enabled ? 'bounded' : 'disabled-control', burst, providerCalls, maxBackgroundTransports: maxActive,
    refused: results.filter(r => r.status === 'rejected').length, foregroundCalls, foregroundOutcomes: foreground.map(r => r.status),
    foregroundMs, cancellationSignalMs,
    approvalTimerMs: controlLatencies[0], approvalWriteMs: controlLatencies[1], wallMs: performance.now() - started,
    cpuMs: (cpuSpent.user + cpuSpent.system) / 1000, rssStart: memory.rss, rssPeak: maxRss, heapStart: memory.heapUsed, heapPeak: maxHeap,
    reservations: budget.snapshot().usage.requests };
  if (enabled && (providerCalls > 2 || record.approvalTimerMs! > 250 || foregroundMs > 250 || (burst && (foreground[0]?.status !== 'fulfilled' || foreground[1]?.status !== 'rejected')))) throw new Error('Resource envelope failed');
  return record;
}
try {
  new BackgroundBudget(() => db);
  const scenarios = [await scenario(true, 0), await scenario(false, 200), await scenario(true, 200)];
  console.log(JSON.stringify({ task: 'Q-20', generatedAt: new Date().toISOString(), runtime: Bun.version,
    hardware: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    profile: 'Synthetic eligible capture calls, 40ms provider, two foreground calls (one cancelled); real SQLite approval denial; no network',
    thresholds: { backgroundTransports: 2, approvalTimerMs: 250, foregroundMs: 250 }, limits: BACKGROUND_LIMITS, scenarios, diagnostics,
    limitations: ['Short synthetic microbenchmark, not live provider latency or production capacity', 'Disabled control uses the same checkout with only the governor disabled', 'Memory peaks are sampled process memory, not a standalone daemon footprint'] }, null, 2));
} finally { console.error = originalError; setBackgroundBudget(null); closeDb(); rmSync(directory, { recursive: true, force: true }); }
