import { existsSync } from 'node:fs';
import { buildEngineBundle } from '../runner/engine-runtime/build';
import { buildAllJarvisPieces } from '../runner/engine-runtime/build-pieces';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { createRunFlowHandler } from '../runner/handler';
import { Worker } from '../queue/worker';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun } from '../db/repos/flow-run';
import { enqueue, cancelJob } from '../db/repos/job-queue';
import { DEFAULT_IDS } from '../db/schema';
import { SandboxApi } from '../sandbox-api/server';
import { CredentialResolver } from '../credentials/adapter';
import { PieceCatalog, metadataToCatalogEntry } from '../runtime/piece-catalog';
import { inspectGraph, checkScenario } from './checks';
import type { EffectExecutor, EffectReceipt, Scenario, ScenarioResult } from './types';

export async function createEvaluationEngine(): Promise<EffectExecutor & { close(): Promise<void>; readiness: boolean }> {
  await buildAllJarvisPieces();
  const bundle = await buildEngineBundle();
  let receipts: EffectReceipt[] = [], scenario: Scenario | null = null;
  const api = new SandboxApi({ services: {
    credentialResolver: new CredentialResolver(),
    notify: async (req, ctx) => {
      if (receipts.length >= 100) throw new Error('Evaluation effect limit reached');
      receipts.push({ kind: 'notification', input: structuredClone(req) as any, runId: ctx.runId, stepName: ctx.stepName ?? null });
      return { delivered: req.channels, failed: [] };
    },
    llmChat: async (req, ctx) => {
      if (receipts.length >= 100) throw new Error('Evaluation effect limit reached');
      receipts.push({ kind: 'ai', input: structuredClone(req) as any, runId: ctx.runId, stepName: ctx.stepName ?? null });
      return { text: scenario?.ai?.reply ?? 'UNEXPECTED SIMULATED AI' };
    },
  } });
  await api.start({ host: '127.0.0.1', port: 0 });
  const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest });
  try {
    const handle = await runtime.acquire({ runId: 'quality-catalog', projectId: DEFAULT_IDS.project });
    const entries = [];
    try {
      for (const name of ['notify', 'regex', 'ask', 'trigger']) {
        const metadata = await handle.extractPieceMetadata({ pieceName: '@jarvispieces/piece-jarvis-' + name, pieceVersion: '0.0.1' });
        entries.push(metadataToCatalogEntry(metadata));
      }
    } finally { await handle.release(); }
    const catalog = new PieceCatalog(entries);
    // W3 is an independent change. Detect its real module, never emulate its checks.
    const readinessUrl = new URL('../db/repos/flow-readiness.ts', import.meta.url);
    const readiness = existsSync(readinessUrl) ? await import(readinessUrl.href) : null;
    readiness?.configureWorkflowReadiness({ pieces: catalog, credentials: new CredentialResolver() });
    return {
      catalog, bundleHash: bundle.hash, readiness: Boolean(readiness),
      async close() { await runtime.shutdown(); await api.stop(); },
      async execute(graph, scenarios) {
        const issues = inspectGraph(graph).issues;
        if (issues.length) return scenarios.map(s => ({
          id: s.id, runId: null, status: 'NOT_EXECUTED', receipts: [], elapsedMs: 0,
          error: issues.join('; '), checks: [{ name: 'supported execution envelope', pass: false }],
        }));
        const flow = createFlow();
        const version = createDraftVersion({ flowId: flow.id, displayName: 'Quality evaluation', trigger: graph });
        const results: ScenarioResult[] = [];
        for (const sample of scenarios) {
          receipts = []; scenario = sample;
          const start = performance.now();
          let runId: string | null = null;
          try {
            readiness?.assertVersionReady(flow.id, version.id);
            const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: 'TESTING' });
            runId = run.id;
            const job = enqueue({ jobType: 'RUN_FLOW', flowRunId: run.id, flowId: flow.id, flowVersionId: version.id,
              payload: { runId: run.id, payload: sample.payload }, maxAttempts: 1 });
            const worker = new Worker({ handlers: { RUN_FLOW: createRunFlowHandler({
              executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 5_000 }),
            }) }, log: () => {} });
            const timer = setTimeout(() => cancelJob(job.id), 30_000);
            try { await worker.drain(); } finally { clearTimeout(timer); }
            const saved = getFlowRun(run.id)!;
            results.push({ id: sample.id, runId, status: saved.status, receipts: structuredClone(receipts),
              checks: checkScenario(sample, saved.status, receipts), elapsedMs: performance.now() - start });
          } catch (error) {
            results.push({ id: sample.id, runId, status: 'ERROR', receipts: structuredClone(receipts),
              checks: [{ name: 'execution completed', pass: false }], error: String(error), elapsedMs: performance.now() - start });
          }
        }
        scenario = null;
        return results;
      },
    };
  } catch (error) { await runtime.shutdown(); await api.stop(); throw error; }
}
