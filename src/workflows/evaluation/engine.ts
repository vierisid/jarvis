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
import { createWaitpoint } from '../db/repos/waitpoint';
import { DEFAULT_IDS } from '../db/schema';
import { SandboxApi } from '../sandbox-api/server';
import type { ToolsInvokeRequest, ToolsInvokeResponse } from '../sandbox-api/routes/jarvis-tools';
import type { JarvisContextProvider } from '../sandbox-api/routes/jarvis-context';
import type { WorkflowEffectContext } from '../runtime/effect-context';
import { CredentialResolver } from '../credentials/adapter';
import { PieceCatalog, metadataToCatalogEntry } from '../runtime/piece-catalog';
import { environmentFor, type EvaluationEnvironment } from './environment';
import { inspectGraph, checkScenario } from './checks';
import type { EffectExecutor, EffectReceipt, Scenario, ScenarioResult } from './types';

export async function createEvaluationEngine(environment: EvaluationEnvironment = environmentFor('w8')):
  Promise<EffectExecutor & { close(): Promise<void>; readiness: boolean; environment: EvaluationEnvironment }> {
  await buildAllJarvisPieces();
  const bundle = await buildEngineBundle();
  let receipts: EffectReceipt[] = [], scenario: Scenario | null = null, approvals = 0;
  const sandbox = () => scenario?.sandbox ?? {};
  const record = (kind: EffectReceipt['kind'], input: Record<string, unknown>, ctx: WorkflowEffectContext, outcome?: EffectReceipt['outcome']) => {
    if (receipts.length >= 100) throw new Error('Evaluation effect limit reached');
    receipts.push({ kind, input: structuredClone(input), runId: ctx.runId, stepName: ctx.stepName ?? null, ...(outcome ? { outcome } : {}) });
  };
  const tools = new Set(environment.tools.map(t => t.name));
  // Each tool answers from the scenario's sandbox the way the daemon would:
  // an offline target or a needed approval means nothing happened.
  async function invokeTool(req: ToolsInvokeRequest, ctx: WorkflowEffectContext): Promise<ToolsInvokeResponse> {
    const s = sandbox(), params = req.params ?? {}, input = { toolName: req.toolName, params };
    const done = (result: unknown): ToolsInvokeResponse => (record('tool', input, ctx, 'succeeded'), { result, toolName: req.toolName, outcome: { status: 'succeeded' } });
    const failed = (status: 'blocked' | 'error', code: string, message: string): ToolsInvokeResponse =>
      (record('tool', input, ctx, status), { result: null, toolName: req.toolName, outcome: { status, code, message, effect: 'not_started' } });
    if (!tools.has(req.toolName)) return failed('blocked', 'TOOL_UNAVAILABLE', req.toolName + ' is not available to workflows');
    if (typeof params.target === 'string' && (s.offlineTargets ?? []).includes(params.target))
      return failed('blocked', 'TARGET_OFFLINE', params.target + ' is offline; nothing was done');
    if ((s.approvals ?? []).includes(req.toolName)) {
      record('tool', input, ctx, 'approval_pending');
      const waitpointId = createWaitpoint({ flowRunId: ctx.runId, projectId: ctx.projectId, stepName: ctx.stepName ?? 'step', type: 'MANUAL' }).id;
      approvals++;
      return { result: null, toolName: req.toolName, approval: { effectId: 'evaluation-effect-' + approvals, approvalId: 'evaluation-approval-' + approvals, waitpointId } };
    }
    const files = s.files ?? {}, path = String(params.path ?? '');
    switch (req.toolName) {
      case 'read_file': return path in files ? done(files[path]) : failed('error', 'FILE_NOT_FOUND', 'No such file: ' + path);
      case 'list_directory': {
        const prefix = path.replace(/\/+$/, '') + '/';
        return done(Object.keys(files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(p => p.slice(prefix.length)).sort().join('\n'));
      }
      case 'get_clipboard': return done(s.clipboard ?? '');
      case 'capture_screen': case 'desktop_snapshot': return done('SIMULATED SCREEN');
      case 'write_file': return done('File written successfully.');
      default: return done('OK');
    }
  }
  const at = { createdAt: 0, updatedAt: 0 };
  const contextProvider: JarvisContextProvider = {
    async vaultSearch(input, ctx) {
      record('context', { action: 'vault_search', ...input }, ctx);
      const query = (input.query ?? '').toLowerCase();
      // As production (context-provider.ts): a case-insensitive match on the entity name only, 25 by default.
      return { result: (sandbox().entities ?? []).filter(e => (!input.type || e.type === input.type)
        && (!query || e.name.toLowerCase().includes(query))).slice(0, input.limit ?? 25).map(e => ({ ...e, ...at })) };
    },
    async vaultGetEntity(id, ctx) {
      record('context', { action: 'vault_get_entity', id }, ctx);
      const entity = (sandbox().entities ?? []).find(e => e.id === id);
      return { result: entity ? { ...entity, ...at } : null };
    },
    async awarenessRecent(input, ctx) {
      record('context', { action: 'awareness_recent', ...input }, ctx);
      return { result: (sandbox().activity ?? []).slice(0, input.limit ?? 20).map(a => ({ ...a, startTime: 0, endTime: null })) };
    },
    async commitmentsList(input, ctx) {
      record('context', { action: 'commitments_list', ...input }, ctx);
      return { result: (sandbox().commitments ?? []).filter(c => !input.status || c.status === input.status)
        .slice(0, input.limit ?? 50).map(c => ({ ...c, createdAt: 0 })) };
    },
  };
  const api = new SandboxApi({ services: {
    credentialResolver: new CredentialResolver(),
    notify: async (req, ctx) => {
      record('notification', req as any, ctx);
      return { delivered: req.channels, failed: [] };
    },
    llmChat: async (req, ctx) => {
      record('ai', req as any, ctx);
      return { text: scenario?.ai?.reply ?? 'UNEXPECTED SIMULATED AI' };
    },
    toolsInvoke: invokeTool,
    contextProvider,
    agentDelegate: async (req, ctx) => {
      record('agent', { goal: req.goal, role: req.role ?? null }, ctx);
      return { finalMessage: sandbox().agentReply ?? 'UNEXPECTED SIMULATED AGENT', toolCalls: [], status: 'completed', outcome: { status: 'succeeded' } };
    },
  } });
  await api.start({ host: '127.0.0.1', port: 0 });
  const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
  try {
    const handle = await runtime.acquire({ runId: 'quality-catalog', projectId: DEFAULT_IDS.project });
    const entries = [];
    try {
      for (const name of environment.jarvisPieces) {
        const metadata = await handle.extractPieceMetadata({ pieceName: '@jarvispieces/piece-jarvis-' + name, pieceVersion: '0.0.1' });
        entries.push(metadataToCatalogEntry(metadata));
      }
    } finally { await handle.release(); }
    // Connection-bound integrations are shown to the composer from fixtures; they never run here.
    const catalog = new PieceCatalog([...entries, ...structuredClone(environment.external)]);
    // W3 is an independent change. Detect its real module, never emulate its checks.
    const readinessUrl = new URL('../db/repos/flow-readiness.ts', import.meta.url);
    const readiness = existsSync(readinessUrl) ? await import(readinessUrl.href) : null;
    // Readiness checks tool steps against the same tool list the composer was shown, as the daemon does.
    readiness?.configureWorkflowReadiness({ pieces: catalog, credentials: new CredentialResolver(),
      tool: (name: string) => environment.tools.find(t => t.name === name) });
    return {
      catalog, bundleHash: bundle.hash, readiness: Boolean(readiness), environment,
      async close() { await runtime.shutdown(); await api.stop(); },
      async execute(graph, scenarios) {
        const inspection = inspectGraph(graph, environment);
        const issues = [...inspection.issues, ...(inspection.external.length ? ['External integrations cannot run in the sandbox'] : [])];
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
