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
import type { AgentOrchestrator } from "../../agents/orchestrator";
import type { AuthorityEngine } from "../../authority/engine";
import type { AuditTrail } from "../../authority/audit";
import type { EmergencyController } from "../../authority/emergency";
import type { RoleDefinition } from "../../roles/types";
import { JarvisLlmClient } from "../adapters/llm-client";
import { JarvisToolRegistryAdapter } from "../adapters/tool-registry";
import { JarvisNotifierAdapter, type NotifierDeps } from "../adapters/notifier";
import { JarvisContextProviderAdapter } from "../adapters/context-provider";
import { LlmOnlyAgentDelegator } from "../adapters/agent-delegator";
import { M7AgentDelegator } from "../adapters/m7-agent-delegator";
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
  /**
   * M7 sub-agent dependencies. When all of these are supplied, `jarvis-agent.delegate`
   * runs the full LLM + tool loop via `runSubAgent`. When any are missing,
   * the backend falls back to the single-shot `LlmOnlyAgentDelegator`.
   *
   * The fallback exists so:
   *   - tests that don't care about agent delegation can omit the wiring,
   *   - the workflow runtime stays usable in early-boot windows before the
   *     daemon's agent-service has finished initializing.
   *
   * Production wiring should always supply all four: orchestrator,
   * specialists, authorityEngine, auditTrail/emergencyController.
   */
  agentOrchestrator?: AgentOrchestrator;
  agentSpecialists?: Map<string, RoleDefinition>;
  authorityEngine?: AuthorityEngine;
  auditTrail?: AuditTrail;
  emergencyController?: EmergencyController;
  /**
   * Optional callback that builds the Jarvis-flavoured system prompt for
   * a workflow LLM call. When set, the `jarvis-ask` piece will pass this
   * prompt to the LLM so the model knows it's Jarvis (role, personality,
   * vault context). Skipped when the piece's `system` field is set --
   * that's the user's explicit override.
   *
   * Production wiring passes `AgentService.buildFullSystemPrompt`.
   */
  buildJarvisSystemPrompt?: (userMessage: string) => string;
}

export function buildSandboxServiceBackends(
  opts: BuildServiceBackendsOptions,
): SandboxApiServices {
  const llmClient = new JarvisLlmClient(opts.llmManager);
  const llmChat: LlmChatFn = async (req) => {
    // System-prompt composition:
    //   - overrideSystem=true       : use `req.system` only. Jarvis
    //                                 context (role, personality, vault
    //                                 knowledge) is dropped. Picked when
    //                                 the user wants generic LLM behaviour
    //                                 (text transforms, summarisation of
    //                                 inputs that shouldn't be coloured
    //                                 by Jarvis's identity).
    //   - `req.system` set, default : Jarvis prompt + "\n\n" + req.system.
    //                                 Lets the user steer the reply (e.g.
    //                                 "respond in JSON") while keeping the
    //                                 Jarvis identity.
    //   - no `req.system`           : Jarvis prompt alone. Default for
    //                                 plain "ask Jarvis" steps.
    //   - no prompt builder wired   : whatever the piece sent (or nothing).
    //                                 Defensive fallback for tests / pre-
    //                                 agent-service bootstrap windows.
    const jarvisSystem = opts.buildJarvisSystemPrompt
      ? opts.buildJarvisSystemPrompt(req.prompt)
      : undefined;
    let system: string | undefined;
    if (req.overrideSystem) {
      system = req.system;
    } else if (req.system && jarvisSystem) {
      system = `${jarvisSystem}\n\n${req.system}`;
    } else {
      system = req.system ?? jarvisSystem;
    }
    const reply = await llmClient.chat({
      prompt: req.prompt,
      ...(system !== undefined ? { system } : {}),
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
    // Real per-channel routing: tryBroadcastToChannels iterates the requested
    // names, dispatches each to its adapter, and reports delivered/failed
    // independently. A flow that says "telegram" only goes to telegram (with
    // a clear error when the adapter isn't connected or no recipient is
    // known yet). Replaces the previous broadcastToAll fan-out which sent
    // every notification to every connected channel.
    broadcastToChannels: (channels, text) =>
      opts.channelService.tryBroadcastToChannels(channels, text),
    // Voice channel = TTS over the same WS path used by awareness
    // suggestions. No-op when no client is connected or no TTS provider
    // is configured; the underlying method handles both.
    sendVoice: (text) => opts.wsService.broadcastProactiveVoice(text),
    // Drives `auto`-channel expansion so unconfigured external channels
    // don't surface as failures on every notification. Explicit
    // `["telegram"]` still bypasses this and attempts delivery either way.
    getConnectedExternalChannels: () => {
      const status = opts.channelService.getChannelStatus();
      const live = new Set<string>();
      for (const [name, connected] of Object.entries(status)) {
        if (connected) live.add(name);
      }
      return live;
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

  // Prefer the full M7 loop when the daemon supplied an orchestrator +
  // specialist registry. Fall back to the single-shot LLM delegator
  // otherwise -- workflow runs still get *some* answer instead of a 503.
  const m7Ready =
    opts.agentOrchestrator !== undefined && opts.agentSpecialists !== undefined;
  const agentAdapter = m7Ready
    ? new M7AgentDelegator({
        orchestrator: opts.agentOrchestrator!,
        llmManager: opts.llmManager,
        specialists: opts.agentSpecialists!,
        ...(opts.authorityEngine ? { authorityEngine: opts.authorityEngine } : {}),
        ...(opts.auditTrail ? { auditTrail: opts.auditTrail } : {}),
        ...(opts.emergencyController ? { emergencyController: opts.emergencyController } : {}),
      })
    : new LlmOnlyAgentDelegator(llmClient);
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
  const workflowsStart: WorkflowsStartFn = async (req, ctx) => {
    const out = await runnerAdapter.start(
      {
        flowId: req.flowId,
        ...(req.payload !== undefined ? { payload: req.payload } : {}),
      },
      // Caller's run id lets the adapter walk the parent-run chain
      // and refuse cycles. Plumbed in by the sandbox-api route from
      // `ctx.claims.runId`.
      ctx.runId,
    );
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
