/**
 * Q-13: run a prepared version once on a fixture, with every service simulated.
 *
 * The real engine executes the exact graph, so routers, loops, expressions and
 * piece input checks behave as they will in production. Every daemon service
 * a supported step can reach is a recorder here: model calls answer from the
 * fixture, notifications and tools are recorded and never delivered, context
 * reads return fixture data. Agent delegation, nested runs and governed piece
 * dispatch are not configured, so the sandbox API refuses them and the step
 * fails closed. `drySupport` refuses community pieces and CODE before the
 * engine starts, because those reach the network without the sandbox API.
 *
 * The run executes a scratch copy of the version, deleted afterwards, so the
 * proposal's own workflow gets no run history. It never enqueues a job: the
 * daemon's worker drains that queue with real services.
 */
import { SandboxApi, type SandboxApiServices } from '../workflows/sandbox-api/server.ts';
import { EngineRuntime } from '../workflows/runner/engine-runtime/engine-runtime.ts';
import { CredentialResolver } from '../workflows/credentials/adapter.ts';
import { createFlow, deleteFlow, getFlow } from '../workflows/db/repos/flow.ts';
import { createDraftVersion, getFlowVersion } from '../workflows/db/repos/flow-version.ts';
import { createFlowRun, getFlowRun } from '../workflows/db/repos/flow-run.ts';
import type { WorkflowEffectContext } from '../workflows/runtime/effect-context.ts';
import { evaluateLlmOutput } from '../workflows/runtime/llm-output-contract.ts';
import { digest } from '../workflows/runtime/effect-context.ts';
import { DRY_RUNNER, drySupport, versionDigest, type DrySample } from './prepared-qualification.ts';

/** Sample data for one dry run. Values are keyed by step name. */
export interface DryFixture {
  id: string;
  /** The trigger output the run starts from. */
  payload: unknown;
  /** Model replies. A step without one fails rather than inventing text. */
  replies?: Record<string, string>;
  /** Tool results. */
  tools?: Record<string, unknown>;
  /** Vault, awareness and commitment read results. */
  context?: Record<string, unknown>;
}

const OUTPUT_MAX_CHARS = 8_000;
const ERROR_MAX_CHARS = 500;
const RUN_TIMEOUT_SECONDS = 60;

type Active = { fixture: DryFixture; simulated: DrySample['simulated'] };

function dryServices(active: () => Active | null): SandboxApiServices {
  const record = (service: DrySample['simulated'][number]['service'], ctx: WorkflowEffectContext) => {
    const run = active();
    if (!run) throw new Error('No dry run is active');
    run.simulated.push({ step: ctx.stepName ?? 'unknown', service });
    return { run, step: ctx.stepName ?? '' };
  };
  const fixture = (values: Record<string, unknown> | undefined, step: string, what: string) => {
    if (!values || !Object.hasOwn(values, step)) throw new Error(`The fixture has no simulated ${what} for ${step}`);
    return structuredClone(values[step]);
  };
  const context = async (ctx: WorkflowEffectContext) => {
    const { run, step } = record('context', ctx);
    return { result: fixture(run.fixture.context, step, 'context result') as never };
  };
  return {
    credentialResolver: new CredentialResolver(),
    llmChat: async (req, ctx) => {
      const { run, step } = record('llm', ctx);
      const text = fixture(run.fixture.replies, step, 'model reply');
      if (typeof text !== 'string') throw new Error(`The simulated model reply for ${step} is not text`);
      // The same contract check production applies to a real reply.
      const evaluated = evaluateLlmOutput({ text, ...(req.parseJson ? { parseJson: true } : {}),
        ...(req.outputSchema ? { outputSchema: req.outputSchema } : {}) });
      return 'parsed' in evaluated ? { text, parsed: evaluated.parsed, outcome: evaluated.outcome } : { text, outcome: evaluated.outcome };
    },
    // Nothing is delivered, and the step's output says so.
    notify: async (_req, ctx) => {
      record('notify', ctx);
      return { delivered: [], failed: [] };
    },
    toolsInvoke: async (req, ctx) => {
      const { run, step } = record('tool', ctx);
      return { result: fixture(run.fixture.tools, step, `${req.toolName} result`), toolName: req.toolName };
    },
    contextProvider: {
      vaultSearch: (_input, ctx) => context(ctx),
      vaultGetEntity: (_id, ctx) => context(ctx),
      awarenessRecent: (_input, ctx) => context(ctx),
      commitmentsList: (_input, ctx) => context(ctx),
    },
  };
}

/** The failing step and the first line of its error; the engine appends a stack trace. */
const failure = (step: { name: string; errorMessage?: string } | null | undefined) =>
  step ? (step.errorMessage ? `${step.name}: ${step.errorMessage.split('\n')[0]}` : step.name) : 'The run did not finish';

function bounded(value: unknown): unknown {
  const text = JSON.stringify(value) ?? 'null';
  return text.length > OUTPUT_MAX_CHARS ? { truncated: true, chars: text.length } : value;
}

export class PreparedDryRunner {
  private active: Active | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(private readonly api: SandboxApi, private readonly runtime: EngineRuntime) {}

  /** `bundlePath` is the built engine bundle the daemon already runs (`buildEngineBundle`). */
  static async start(bundlePath: string): Promise<PreparedDryRunner> {
    const holder: { runner?: PreparedDryRunner } = {};
    const api = new SandboxApi({ services: dryServices(() => holder.runner?.active ?? null) });
    await api.start({ host: '127.0.0.1', port: 0 });
    holder.runner = new PreparedDryRunner(api, new EngineRuntime({ api, bundlePath }));
    return holder.runner;
  }

  async close(): Promise<void> {
    await this.tail.catch(() => {});
    await this.runtime.shutdown();
    await this.api.stop();
  }

  /** Runs are serialized: the simulated services belong to one run at a time. */
  run(flowId: string, versionId: string, fixture: DryFixture): Promise<DrySample> {
    const next = this.tail.then(() => this.execute(flowId, versionId, fixture), () => this.execute(flowId, versionId, fixture));
    this.tail = next.catch(() => {});
    return next;
  }

  private async execute(flowId: string, versionId: string, fixture: DryFixture): Promise<DrySample> {
    const flow = getFlow(flowId), version = getFlowVersion(versionId);
    if (!flow || !version || version.flowId !== flowId) throw new Error('The workflow version does not exist in this workflow');
    const unsupported = drySupport(version.trigger);
    if (unsupported) throw new Error(`The dry runner cannot run this workflow: ${unsupported}`);
    const pinned = versionDigest(version.trigger);
    const scratch = createFlow({ projectId: flow.project_id, metadata: { preparedDryRunOf: flowId } });
    try {
      const copy = createDraftVersion({ flowId: scratch.id, displayName: version.displayName, trigger: version.trigger });
      if (versionDigest(copy.trigger) !== pinned) throw new Error('The scratch copy does not match the version');
      const run = createFlowRun({ flowId: scratch.id, flowVersionId: copy.id, environment: 'TESTING' });
      const active: Active = { fixture, simulated: [] };
      let error: string | null = null;
      // An engine that cannot start is the runner's failure, not the
      // workflow's: it throws, so the caller can retry instead of recording a
      // failed sample against the proposal.
      const handle = await this.runtime.acquire({ runId: run.id, projectId: flow.project_id });
      this.active = active;
      try {
        // Streamed step progress is what records each step's output on the run.
        await handle.executeFlow({ flowVersion: copy, triggerPayload: fixture.payload, runEnvironment: 'TESTING',
          streamStepProgress: 'WEBSOCKET', timeoutInSeconds: RUN_TIMEOUT_SECONDS });
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      } finally {
        this.active = null;
        await handle.release();
      }
      const settled = getFlowRun(run.id);
      // Each streamed step is stored as { output: <engine step record> }, whose own `output` is the result.
      const steps = (settled?.steps ?? {}) as Record<string, { output?: { output?: unknown } } | undefined>;
      return {
        runner: DRY_RUNNER, flowId, versionId, versionDigest: pinned,
        fixtureId: fixture.id, fixtureDigest: digest(fixture),
        status: error ? 'FAILED' : settled?.status ?? 'FAILED',
        error: (error ?? (settled?.status === 'SUCCEEDED' ? null : failure(settled?.failedStep)))?.slice(0, ERROR_MAX_CHARS) ?? null,
        simulated: active.simulated,
        outputs: Object.fromEntries(Object.entries(steps).map(([name, step]) => [name, bounded(step?.output?.output ?? null)])),
      };
    } finally {
      deleteFlow(scratch.id);
    }
  }
}
