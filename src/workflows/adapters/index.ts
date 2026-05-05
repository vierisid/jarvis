/**
 * One-stop entry point that builds a `JarvisPieceServices` bag from the
 * daemon's existing services. Each adapter is optional -- the daemon decides
 * which to plug in based on what it has constructed at startup. Pieces whose
 * service is missing throw at execute() time with a clear message.
 */

import type { JarvisPieceServices } from "../jarvis-pieces/types";
import type { LLMManager } from "../../llm/manager";
import type { ToolRegistry } from "../../actions/tools/registry";
import { JarvisLlmClient } from "./llm-client";
import { JarvisToolRegistryAdapter } from "./tool-registry";
import { JarvisNotifierAdapter, type NotifierDeps } from "./notifier";
import { JarvisContextProviderAdapter } from "./context-provider";
import { JarvisWorkflowRunnerAdapter } from "./workflow-runner";
import { JarvisEventBusAdapter } from "./event-bus";
import { LlmOnlyAgentDelegator } from "./agent-delegator";

export {
  JarvisLlmClient,
  JarvisToolRegistryAdapter,
  JarvisNotifierAdapter,
  JarvisContextProviderAdapter,
  JarvisWorkflowRunnerAdapter,
  JarvisEventBusAdapter,
  LlmOnlyAgentDelegator,
};

export interface BuildPieceServicesDeps {
  llmManager?: LLMManager;
  toolRegistry?: ToolRegistry;
  notifier?: NotifierDeps;
  /**
   * Pre-constructed event bus. Pass when daemon code (TriggerManager,
   * publishers elsewhere) needs to share the same bus instance pieces use.
   * If omitted, a fresh bus is created.
   */
  eventBus?: JarvisEventBusAdapter;
  /**
   * Pre-constructed workflow runner. Same rationale as eventBus.
   */
  workflowRunner?: JarvisWorkflowRunnerAdapter;
}

/**
 * Build a fully-populated `JarvisPieceServices` from the daemon's existing
 * services. Components passed as `undefined` produce no entry in the result;
 * pieces that need that service will throw on use.
 *
 * Notes:
 *   - The context provider has no dependencies (it reads the vault DB
 *     directly), so it's always populated.
 *   - The event bus is always populated and starts empty; daemon code can
 *     publish into it via `services.eventBus.publish(...)` (cast as
 *     `JarvisEventBusAdapter`).
 *   - The workflow runner has no dependencies (it talks to the workflow DB
 *     and queue directly), so it's always populated.
 *   - The agent delegator falls back to the LLM-only impl if an LLM is
 *     available; if neither LLM nor an M7 backend is present, it's omitted.
 */
export function buildPieceServices(deps: BuildPieceServicesDeps): JarvisPieceServices {
  const services: JarvisPieceServices = {
    context: new JarvisContextProviderAdapter(),
    eventBus: deps.eventBus ?? new JarvisEventBusAdapter(),
    workflowRunner: deps.workflowRunner ?? new JarvisWorkflowRunnerAdapter(),
  };

  if (deps.llmManager) {
    const llm = new JarvisLlmClient(deps.llmManager);
    services.llm = llm;
    services.agentDelegator = new LlmOnlyAgentDelegator(llm);
  }
  if (deps.toolRegistry) {
    services.toolRegistry = new JarvisToolRegistryAdapter(deps.toolRegistry);
  }
  if (deps.notifier) {
    services.notifier = new JarvisNotifierAdapter(deps.notifier);
  }
  return services;
}
