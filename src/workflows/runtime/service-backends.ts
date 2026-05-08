/**
 * Glue layer: wraps existing Jarvis adapters into the function-shape that the
 * SandboxApi service-backend slots expect. Each `/v1/jarvis/*` route takes a
 * function or object on `SandboxApiServices`; the legacy adapters expose
 * different signatures that grew before this engine wiring landed. This
 * module lives here (not in the daemon) so the wiring is testable + reused
 * by the L gmail smoke test.
 *
 * Lives outside `adapters/` so the eventual K3 deletion of the legacy
 * adapters doesn't have to thread through this file.
 */

import type { LLMManager } from "../../llm/manager";
import type { ToolRegistry } from "../../actions/tools/registry";
import type { ChannelService } from "../../daemon/channel-service";
import type { WebSocketService } from "../../daemon/ws-service";
import { JarvisLlmClient } from "../adapters/llm-client";
import { JarvisToolRegistryAdapter } from "../adapters/tool-registry";
import { JarvisNotifierAdapter, type NotifierDeps } from "../adapters/notifier";
import { JarvisContextProviderAdapter } from "../adapters/context-provider";
import { LlmOnlyAgentDelegator } from "../adapters/agent-delegator";
import { JarvisWorkflowRunnerAdapter } from "../adapters/workflow-runner";
import type { LlmChatFn } from "../sandbox-api/routes/jarvis-llm";
import type { ToolsInvokeFn } from "../sandbox-api/routes/jarvis-tools";
import type { NotifyFn } from "../sandbox-api/routes/jarvis-notify";
import type { JarvisContextProvider } from "../sandbox-api/routes/jarvis-context";
import type { AgentDelegateFn } from "../sandbox-api/routes/jarvis-agent";
import type { EventsPollFn } from "../sandbox-api/routes/jarvis-events";
import type { WorkflowsStartFn } from "../sandbox-api/routes/jarvis-workflows";
import type { SandboxApiServices } from "../sandbox-api/server";
import type { CredentialResolver } from "../credentials/adapter";
import { WorkflowEventBuffer } from "./event-buffer";

export interface BuildServiceBackendsOptions {
  credentialResolver: CredentialResolver;
  llmManager: LLMManager;
  toolRegistry?: ToolRegistry;
  channelService: ChannelService;
  wsService: WebSocketService;
  /**
   * Optional desktop-notification sender. Receives `(title, body)`. The daemon
   * passes a function that calls `sendDesktopNotification` with normal urgency.
   */
  sendDesktop?: (title: string, body: string) => Promise<void>;
  /** Recent-events buffer for `jarvis-trigger:on_event` polling. */
  eventBuffer: WorkflowEventBuffer;
  /**
   * URL prefix used to mint resumeUrl values for waitpoints. Should be a
   * publicly reachable URL of the daemon. Default: empty string -- the
   * waitpoint route will mint relative URLs that callers must concatenate.
   */
  resumeUrlPrefix?: string;
}

export function buildSandboxServiceBackends(
  opts: BuildServiceBackendsOptions,
): SandboxApiServices {
  const llmClient = new JarvisLlmClient(opts.llmManager);
  const llmChat: LlmChatFn = async (req) => {
    const reply = await llmClient.chat({
      prompt: req.prompt,
      ...(req.system !== undefined ? { system: req.system } : {}),
    });
    if (req.parseJson) {
      try {
        return { text: reply.text, parsed: JSON.parse(reply.text) };
      } catch {
        // Fall back to the raw text; the piece-side action surfaces both
        // fields so the caller can handle parse failures explicitly.
        return { text: reply.text };
      }
    }
    return { text: reply.text };
  };

  const toolAdapter = opts.toolRegistry
    ? new JarvisToolRegistryAdapter(opts.toolRegistry)
    : null;
  const toolsInvoke: ToolsInvokeFn | undefined = toolAdapter
    ? async (req) => {
        if (!toolAdapter.has(req.toolName)) {
          throw new Error(`tool not found: ${req.toolName}`);
        }
        const result = await toolAdapter.execute(req.toolName, req.params);
        return { result, toolName: req.toolName };
      }
    : undefined;

  const notifierDeps: NotifierDeps = {
    broadcastToDashboard: (text, priority) =>
      opts.wsService.broadcastNotification(text, priority),
    broadcastToChannels: async (channels, text) => {
      // Per-channel routing isn't exposed yet; broadcastToAll is the only
      // fan-out. Treat each requested channel as delivered when the call
      // succeeds.
      try {
        await opts.channelService.broadcastToAll(text);
        return { delivered: channels, failed: [] };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        return { delivered: [], failed: channels.map((channel) => ({ channel, error })) };
      }
    },
    ...(opts.sendDesktop ? { sendDesktop: opts.sendDesktop } : {}),
  };
  const notifierAdapter = new JarvisNotifierAdapter(notifierDeps);
  const notify: NotifyFn = async (req) => {
    const result = await notifierAdapter.notify({
      message: req.message,
      channels: req.channels as Parameters<typeof notifierAdapter.notify>[0]["channels"],
      priority: req.priority,
    });
    return { delivered: result.delivered, failed: result.failed };
  };

  const contextAdapter = new JarvisContextProviderAdapter();
  const contextProvider: JarvisContextProvider = {
    vaultSearch: (input) =>
      contextAdapter.vaultSearch(
        input as Parameters<typeof contextAdapter.vaultSearch>[0],
      ),
    vaultGetEntity: (id) => contextAdapter.vaultGetEntity(id),
    awarenessRecent: (input) => contextAdapter.awarenessRecent(input),
    commitmentsList: (input) =>
      contextAdapter.commitmentsList(
        input as Parameters<typeof contextAdapter.commitmentsList>[0],
      ),
  };

  const agentAdapter = new LlmOnlyAgentDelegator(llmClient);
  const agentDelegate: AgentDelegateFn = async (req) => {
    const result = await agentAdapter.delegate({
      goal: req.goal,
      ...(req.role !== undefined ? { role: req.role } : {}),
      ...(req.maxIterations !== undefined ? { maxIterations: req.maxIterations } : {}),
    });
    return result;
  };

  const eventsPoll: EventsPollFn = async (req) => {
    const reply = opts.eventBuffer.poll(req);
    // The route's `JarvisEvent` types `id` as a string (consistent with all
    // other engine ids); the buffer assigns monotonic numbers internally.
    // Stringify at the boundary so the wire shape stays uniform.
    return {
      events: reply.events.map((ev) => ({
        id: String(ev.id),
        eventType: ev.eventType,
        payload: ev.payload,
        timestamp: ev.timestamp,
      })),
      cursor: reply.cursor,
    };
  };

  const runnerAdapter = new JarvisWorkflowRunnerAdapter();
  const workflowsStart: WorkflowsStartFn = async (req) => {
    const out = await runnerAdapter.start({
      ...(req.flowId !== undefined ? { flowId: req.flowId } : {}),
      ...(req.flowName !== undefined ? { flowName: req.flowName } : {}),
      ...(req.payload !== undefined ? { payload: req.payload } : {}),
    });
    return { runId: out.runId };
  };

  const services: SandboxApiServices = {
    credentialResolver: opts.credentialResolver,
    llmChat,
    notify,
    contextProvider,
    agentDelegate,
    eventsPoll,
    workflowsStart,
    ...(opts.resumeUrlPrefix !== undefined ? { resumeUrlPrefix: opts.resumeUrlPrefix } : {}),
  };
  if (toolsInvoke) services.toolsInvoke = toolsInvoke;
  return services;
}
