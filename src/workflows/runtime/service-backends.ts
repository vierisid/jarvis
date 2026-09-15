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
import type { SystemPromptParts } from "../../roles/prompt-builder";
import type { ToolsInvokeFn } from "../sandbox-api/routes/jarvis-tools";
import type { NotifyFn } from "../sandbox-api/routes/jarvis-notify";
import type { JarvisContextProvider } from "../sandbox-api/routes/jarvis-context";
import type { AgentDelegateFn } from "../sandbox-api/routes/jarvis-agent";
import type { EventsPollFn } from "../sandbox-api/routes/jarvis-events";
import type { WorkflowsStartFn } from "../sandbox-api/routes/jarvis-workflows";
import type { SandboxApiServices } from "../sandbox-api/server";
import type { CredentialResolver } from "../credentials/adapter";
import { WorkflowEventBuffer } from "./event-buffer";
import { cancellableWorkflowService } from "./cancellation";
import { WorkflowEffectBoundary, type WorkflowAuthorityDependencies } from './effect-boundary';
import { assertWorkflowCapabilities, toolEffectCapability } from './effect-capabilities';
import { getFlow } from '../db/repos/flow';
import { getFlowVersion, getLatestDraft } from '../db/repos/flow-version';
import { digest } from './effect-context';

export interface BuildServiceBackendsOptions extends WorkflowAuthorityDependencies {
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
   * Production wiring supplies orchestrator, specialists, Authority, audit and
   * emergency components. Direct effects fail closed without governance;
   * delegated execution falls back to an LLM-only response with no tool loop.
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
   * Returned split at the prompt-cache boundary (static role prompt vs
   * per-call context) so the provider can cache the static prefix across
   * workflow LLM calls.
   *
   * Production wiring passes `AgentService.buildFullSystemPromptParts`.
   */
  buildJarvisSystemPrompt?: (userMessage: string) => SystemPromptParts;
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
    const jarvisParts = opts.buildJarvisSystemPrompt
      ? opts.buildJarvisSystemPrompt(req.prompt)
      : undefined;
    let system: string | undefined;
    let systemParts: { static: string; dynamic?: string } | undefined;
    if (req.overrideSystem) {
      system = req.system;
    } else if (jarvisParts) {
      // Static Jarvis prefix stays cacheable; per-call context and the
      // piece's steering prompt ride on the dynamic half. Rendered text is
      // identical to the old `jarvis + '\n\n' + req.system` join.
      const dynamic = [jarvisParts.dynamic, req.system].filter(Boolean).join('\n\n');
      systemParts = { static: jarvisParts.static, ...(dynamic ? { dynamic } : {}) };
    } else {
      system = req.system;
    }
    const reply = await llmClient.chat({
      prompt: req.prompt,
      ...(system !== undefined ? { system } : {}),
      ...(systemParts !== undefined ? { systemParts } : {}),
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
  const effects = new WorkflowEffectBoundary(opts);
  const toolsInvoke: ToolsInvokeFn | undefined = toolAdapter
    ? async (req, ctx) => {
        if (!toolAdapter.has(req.toolName)) {
          throw new Error(`tool not found: ${req.toolName}`);
        }
        const tool = opts.toolRegistry!.get(req.toolName)!;
        const capability = toolEffectCapability(tool);
        const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-tool', action: 'invoke',
          route: 'tool', toolName: tool.name, category: capability.category, toolCategory: tool.category,
          request: { ...req }, prepare: () => {
            const args = capability.prepareArguments(req.params);
            return { arguments: args, target: capability.target(args) };
          },
          validateTarget: (args, target) => {
            if (digest(capability.target(args)) !== digest(target)) throw new Error('Workflow execution target changed after review; dispatch blocked');
          },
          execute: async (args, checkpoint) => { checkpoint(); return toolAdapter.execute(req.toolName, args); } });
        return reply.approval ? { result: null, toolName: req.toolName, approval: reply.approval }
          : { result: reply.result, toolName: req.toolName };
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
  const notify: NotifyFn = async (req, ctx) => {
    const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-notify', action: 'notify',
      route: 'notify', toolName: 'workflow_notify', category: 'send_message', toolCategory: 'notification', request: { ...req },
      prepare: () => {
        const channels = new Set<string>();
        for (const channel of req.channels.length ? req.channels : ['auto']) {
          if (channel !== 'auto') channels.add(channel);
          else {
            channels.add('dashboard');
            for (const external of notifierDeps.getConnectedExternalChannels!()) channels.add(external);
          }
        }
        const recipients = Object.fromEntries([...channels].map(channel => [channel,
          ['telegram', 'discord'].includes(channel) ? opts.channelService.getBroadcastRecipient(channel) : null]));
        return { arguments: { ...req, channels: [...channels], recipients }, target: { channels: [...channels], recipients } };
      },
      execute: async (args, checkpoint) => {
        const recipients = args.recipients as Record<string, string | null>;
        const guardedNotifier = new JarvisNotifierAdapter({ ...notifierDeps,
          broadcastToDashboard: (text, priority) => { checkpoint(); opts.wsService.broadcastNotification(text, priority); },
          broadcastToChannels: async (channels, text) => {
            const delivered: string[] = [], failed: { channel: string; error: string }[] = [];
            for (const channel of channels) {
              try {
                checkpoint();
                await opts.channelService.sendWorkflowNotification(channel, recipients[channel] ?? null, text, checkpoint);
                delivered.push(channel);
              } catch (error) { failed.push({ channel, error: (error as Error).message }); }
            }
            return { delivered, failed };
          },
          sendVoice: async text => { checkpoint(); await opts.wsService.broadcastProactiveVoice(text, checkpoint); },
          ...(opts.sendDesktop ? { sendDesktop: async (title: string, body: string) => { checkpoint(); await opts.sendDesktop!(title, body); } } : {}),
        });
        return guardedNotifier.notify({ message: args.message as string, channels: args.channels as any, priority: args.priority as any });
      },
    });
    return reply.approval ? { delivered: [], failed: [], approval: reply.approval } : reply.result as Awaited<ReturnType<NotifyFn>>;
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
    opts.agentOrchestrator !== undefined && opts.agentSpecialists !== undefined
    && opts.authorityEngine !== undefined && opts.auditTrail !== undefined && opts.emergencyController !== undefined;
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
  const agentDelegate: AgentDelegateFn = async (req, ctx) => {
    if (!m7Ready) return agentAdapter.delegate(req); // LLM-only fallback has no tool effects.
    const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-agent', action: 'delegate',
      route: 'agent', toolName: 'workflow_delegate', category: 'spawn_agent', toolCategory: 'delegation',
      request: { ...req }, prepare: () => ({ arguments: { ...req }, target: { role: req.role ?? 'workflow-default' } }),
      execute: async (args, checkpoint) => {
        checkpoint();
        // The M7 runner still applies its own role, taint, Authority and
        // emergency gates to every child tool. Approval here grants delegation only.
        return agentAdapter.delegate(args as unknown as Parameters<typeof agentAdapter.delegate>[0]);
      },
    });
    return reply.approval ? { finalMessage: '', toolCalls: [], status: 'approval_required', approval: reply.approval }
      : reply.result as Awaited<ReturnType<AgentDelegateFn>>;
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
  const childVersion = (flowId: string) => {
    const flow = getFlow(flowId);
    const versionId = flow?.published_version_id ?? (flow ? getLatestDraft(flow.id)?.id : null);
    const version = versionId ? getFlowVersion(versionId) : null;
    if (!version) throw new Error('Target workflow version is unavailable');
    assertWorkflowCapabilities(version.trigger);
    return { versionId: version.id, versionDigest: digest(version.trigger) };
  };
  const workflowsStart: WorkflowsStartFn = async (req, ctx) => {
    const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-trigger', action: 'run_workflow',
      route: 'workflow', toolName: 'workflow_start', category: 'spawn_agent', toolCategory: 'delegation',
      request: { ...req }, prepare: () => {
        const pinned = childVersion(req.flowId);
        return { arguments: { ...req, pinned }, target: { flowId: req.flowId, ...pinned } };
      },
      execute: async (args, checkpoint) => {
        checkpoint();
        if (digest(childVersion(args.flowId as string)) !== digest(args.pinned)) throw new Error('Target workflow changed after approval; start a new run');
        return runnerAdapter.start(args as unknown as Parameters<typeof runnerAdapter.start>[0], ctx.runId);
      },
    });
    return reply.approval ? { runId: null, approval: reply.approval }
      : reply.result as Awaited<ReturnType<WorkflowsStartFn>>;
  };

  const services: SandboxApiServices = {
    credentialResolver: opts.credentialResolver,
    assertFlowCapabilities: assertWorkflowCapabilities,
    llmChat: cancellableWorkflowService(llmChat),
    notify: cancellableWorkflowService(notify),
    contextProvider,
    agentDelegate: cancellableWorkflowService(agentDelegate),
    eventsPoll,
    workflowsStart: cancellableWorkflowService(workflowsStart),
    ...(opts.resumeUrlPrefix !== undefined ? { resumeUrlPrefix: opts.resumeUrlPrefix } : {}),
  };
  if (toolsInvoke) services.toolsInvoke = cancellableWorkflowService(toolsInvoke);
  return services;
}
