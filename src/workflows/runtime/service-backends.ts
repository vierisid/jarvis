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
import { M7AgentDelegator, type DelegationContinuation } from "../adapters/m7-agent-delegator";
import { getDelegation, saveDelegation } from "../db/repos/delegation";
import { JarvisWorkflowRunnerAdapter } from "../adapters/workflow-runner";
import type { LlmChatFn, LlmChatRequest, LlmChatResponse } from "../sandbox-api/routes/jarvis-llm";
import type { SystemPromptParts } from "../../roles/prompt-builder";
import type { ToolsInvokeFn } from "../sandbox-api/routes/jarvis-tools";
import type { PieceAuthorizeFn } from "../sandbox-api/routes/jarvis-pieces";
import type { NotifyFn } from "../sandbox-api/routes/jarvis-notify";
import type { ContextReply, JarvisContextProvider } from "../sandbox-api/routes/jarvis-context";
import type { AgentDelegateFn } from "../sandbox-api/routes/jarvis-agent";
import type { EventsPollFn } from "../sandbox-api/routes/jarvis-events";
import type { WorkflowsStartFn } from "../sandbox-api/routes/jarvis-workflows";
import type { SandboxApiServices } from "../sandbox-api/server";
import type { CredentialResolver } from "../credentials/adapter";
import { WorkflowEventBuffer } from "./event-buffer";
import { cancellableWorkflowService } from "./cancellation";
import { WorkflowEffectBoundary, workflowEffectId, type WorkflowAuthorityDependencies } from './effect-boundary';
import { getWorkflowEffect } from '../db/repos/workflow-effect';
import { OPAQUE_TOOL_NAMES, refusedEffectCategory, toolEffectCapability } from './effect-capabilities';
import { ActionOutcomeError } from '../../actions/action-outcome';
import { governedPieceToolDefinition, resolveGovernedPieceAction, sanitizePieceInput } from './piece-effects';
import { getFlow } from '../db/repos/flow';
import { getFlowVersion, getLatestDraft } from '../db/repos/flow-version';
import { digest, resolveEffectContext, type WorkflowEffectContext } from './effect-context';
import { evaluateLlmOutput } from './llm-output-contract';
import { withWorkflowMachineBinding } from './machine-binding';
import { getMachineScope } from '../../actions/machine-scope';
import type { SidecarCapability } from '../../sidecar/types';

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
  /**
   * Builds the tool registry a delegated sub-agent may call, from its role's
   * allowed categories. Production leaves this unset and gets the builtin
   * tools; tests supply synthetic ones so an approved call has no real effect.
   */
  agentScopedRegistry?: (allowedCategories: string[]) => ToolRegistry;
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
  const effects = new WorkflowEffectBoundary(opts);
  const callLlm = async (req: LlmChatRequest): Promise<LlmChatResponse> => {
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
    // The provider has answered, so the contract check qualifies a completed
    // call rather than blocking one: `parsed` exists only when the reply met
    // the request, and the outcome names the contract that failed otherwise.
    const evaluated = evaluateLlmOutput({ text: reply.text, ...(req.parseJson ? { parseJson: true } : {}),
      ...(req.outputSchema ? { outputSchema: req.outputSchema } : {}) });
    return 'parsed' in evaluated ? { text: reply.text, parsed: evaluated.parsed, outcome: evaluated.outcome }
      : { text: reply.text, outcome: evaluated.outcome };
  };
  const llmChat: LlmChatFn = async (req, ctx) => {
    // requireSuccess controls how the caller handles the receipt, not what
    // leaves the device. Keeping it out of the effect identity lets an
    // approval granted to an older piece resume once the upgraded piece
    // starts sending the default explicitly.
    const { requireSuccess: _handled, ...effectRequest } = req;
    const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-ask', action: 'ask',
      route: 'llm', toolName: 'workflow_ask', category: 'read_data', toolCategory: 'llm',
      request: { ...effectRequest },
      // The prompt is the payload that leaves the device, so it is what gets
      // frozen and reviewed -- not the daemon-composed system prompt above.
      prepare: () => ({ arguments: { ...effectRequest }, target: { destination: 'llm-provider', overrideSystem: req.overrideSystem === true } }),
      execute: async (args, checkpoint) => { checkpoint(); return callLlm(args as unknown as LlmChatRequest); },
    });
    return reply.approval ? { text: '', approval: reply.approval } : reply.result as LlmChatResponse;
  };

  const toolAdapter = opts.toolRegistry
    ? new JarvisToolRegistryAdapter(opts.toolRegistry)
    : null;
  const toolsInvoke: ToolsInvokeFn | undefined = toolAdapter
    ? async (req, ctx) => {
        if (!toolAdapter.has(req.toolName)) {
          throw new Error(`tool not found: ${req.toolName}`);
        }
        const tool = opts.toolRegistry!.get(req.toolName)!;
        const capability = (() => {
          try { return toolEffectCapability(tool); }
          catch (error) {
            // Refusing a capability is a governance decision, so it is audited
            // even though no durable effect record exists for it yet.
            effects.auditRefusal({ context: ctx, toolName: tool.name, category: refusedEffectCategory(tool) });
            throw error;
          }
        })();
        const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-tool', action: 'invoke',
          route: 'tool', toolName: tool.name, category: capability.category, toolCategory: tool.category,
          // Spelled out rather than spread: the request is what the effect's
          // identity digest is taken over, so only the two fields that decide
          // WHAT is dispatched belong in it. A reply-handling flag added to
          // the route's body must never invalidate a pending approval.
          request: { toolName: req.toolName, params: req.params }, prepare: () => {
            const args = capability.prepareArguments(req.params);
            return { arguments: args, target: capability.target(args) };
          },
          validateTarget: (args, target) => {
            if (digest(capability.target(args)) !== digest(target)) throw new Error('Workflow execution target changed after review; dispatch blocked');
            if (target.machineBinding) getMachineScope()?.assertDispatch(target.sidecarId as string | null, target.capability as SidecarCapability);
          },
          execute: async (args, checkpoint) => { checkpoint(); return toolAdapter.execute(req.toolName, args); } });
        return reply.approval ? { result: null, toolName: req.toolName, approval: reply.approval }
          : { result: reply.result, toolName: req.toolName };
      }
    : undefined;

  const notifierDeps: NotifierDeps = {
    broadcastToDashboard: (text, priority) =>
      opts.wsService.broadcastNotificationToDashboard(text, priority),
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
          broadcastToDashboard: (text, priority) => { checkpoint(); opts.wsService.broadcastNotificationToDashboard(text, priority); },
          broadcastToChannels: async (channels, text) => {
            const delivered: string[] = [], failed: { channel: string; error: string }[] = [];
            for (const channel of channels) {
              try {
                checkpoint();
                await opts.channelService.sendWorkflowNotification(channel, recipients[channel] ?? null, text);
                delivered.push(channel);
              } catch (error) { failed.push({ channel, error: (error as Error).message }); }
            }
            return { delivered, failed };
          },
          sendVoice: async text => { checkpoint(); await opts.wsService.broadcastProactiveVoice(text); },
          ...(opts.sendDesktop ? { sendDesktop: async (title: string, body: string) => { checkpoint(); await opts.sendDesktop!(title, body); } } : {}),
        });
        return guardedNotifier.notify({ message: args.message as string, channels: args.channels as any, priority: args.priority as any });
      },
    });
    return reply.approval ? { delivered: [], failed: [], approval: reply.approval } : reply.result as Awaited<ReturnType<NotifyFn>>;
  };

  const contextAdapter = new JarvisContextProviderAdapter();
  /**
   * Vault entities, commitments and screen-capture history are the most
   * sensitive things a workflow can read, and a read is the first half of an
   * exfiltration. Each one is a governed `read_data` effect, so a user who puts
   * `read_data` under Authority governs both this and `jarvis-ask` -- the source
   * and the sink of that path -- with a single setting.
   */
  const contextEffect = async <T>(
    ctx: WorkflowEffectContext,
    action: string,
    store: string,
    request: Record<string, unknown>,
    run: (args: Record<string, unknown>) => Promise<T>,
  ): Promise<ContextReply<T>> => {
    const reply = await effects.invoke({ context: ctx, piece: '@jarvispieces/piece-jarvis-context', action,
      route: `context:${action}`, toolName: `workflow_${action}`, category: 'read_data', toolCategory: 'context',
      request: { ...request }, prepare: () => ({ arguments: { ...request }, target: { store } }),
      execute: async (args, checkpoint) => { checkpoint(); return run(args); },
    });
    return reply.approval ? { approval: reply.approval } : { result: reply.result as T };
  };
  // Wrapped like `llmChat` and `notify`: a canceled run must not read either.
  const contextProvider: JarvisContextProvider = {
    vaultSearch: cancellableWorkflowService((input, ctx) =>
      contextEffect(ctx, 'vault_search', 'vault', { ...input }, (args) =>
        contextAdapter.vaultSearch(
          args as Parameters<typeof contextAdapter.vaultSearch>[0],
        ),
      ),
    ),
    vaultGetEntity: cancellableWorkflowService((id: string, ctx) =>
      contextEffect(ctx, 'vault_get_entity', 'vault', { id }, (args) =>
        contextAdapter.vaultGetEntity(args.id as string),
      ),
    ),
    awarenessRecent: cancellableWorkflowService((input, ctx) =>
      contextEffect(ctx, 'awareness_recent', 'awareness', { ...input }, (args) =>
        contextAdapter.awarenessRecent(args),
      ),
    ),
    commitmentsList: cancellableWorkflowService((input, ctx) =>
      contextEffect(ctx, 'commitments_list', 'commitments', { ...input }, (args) =>
        contextAdapter.commitmentsList(
          args as Parameters<typeof contextAdapter.commitmentsList>[0],
        ),
      ),
    ),
  };

  // Prefer the full M7 loop when the daemon supplied an orchestrator +
  // specialist registry. Fall back to the single-shot LLM delegator
  // otherwise -- workflow runs still get *some* answer instead of a 503.
  const m7Ready =
    opts.agentOrchestrator !== undefined && opts.agentSpecialists !== undefined
    && opts.authorityEngine !== undefined && opts.auditTrail !== undefined && opts.emergencyController !== undefined;
  const m7 = m7Ready
    ? new M7AgentDelegator({
        orchestrator: opts.agentOrchestrator!,
        llmManager: opts.llmManager,
        specialists: opts.agentSpecialists!,
        ...(opts.authorityEngine ? { authorityEngine: opts.authorityEngine } : {}),
        ...(opts.auditTrail ? { auditTrail: opts.auditTrail } : {}),
        ...(opts.emergencyController ? { emergencyController: opts.emergencyController } : {}),
        ...(opts.agentScopedRegistry ? { scopedRegistry: opts.agentScopedRegistry } : {}),
      })
    : null;
  const llmOnlyDelegator = new LlmOnlyAgentDelegator(llmClient);
  const AGENT_PIECE = '@jarvispieces/piece-jarvis-agent';
  const agentDelegate: AgentDelegateFn = async (req, ctx) => {
    if (!m7) return llmOnlyDelegator.delegate(req); // LLM-only fallback has no tool effects.
    // How the caller handles the outcome is not part of what is dispatched.
    const { requiredTools: _required, requireSuccess: _handled, ...effectRequest } = req;
    // The decision to delegate at all. The sub-agent's governed tool calls
    // each pass the boundary below as their own effects; this record only
    // says delegation was allowed, so a step the engine runs again resumes
    // the conversation instead of asking to delegate a second time.
    const reply = await effects.invoke({ context: ctx, piece: AGENT_PIECE, action: 'delegate',
      route: 'agent', toolName: 'workflow_delegate', category: 'spawn_agent', toolCategory: 'delegation',
      request: { ...effectRequest }, prepare: () => ({ arguments: { ...effectRequest }, target: { role: req.role ?? 'workflow-default' } }),
      execute: async (_args, checkpoint) => { checkpoint(); return { dispatch: 'authorized' }; },
    });
    if (reply.approval) return { finalMessage: '', toolCalls: [], status: 'approval_required', approval: reply.approval };
    const resolved = resolveEffectContext(ctx, AGENT_PIECE, 'delegate');
    const id = 'wfd_' + digest([resolved.run.id, resolved.stepName, resolved.executionPath]);
    const continuation: DelegationContinuation = {
      identity: { id, runId: resolved.run.id, stepName: resolved.stepName, executionPath: resolved.executionPath,
        versionDigest: resolved.versionDigest },
      load: () => getDelegation(id),
      save: saveDelegation,
      // A governed call inside the sub-agent is a workflow effect of its own:
      // bound to the run, version, step and loop position by the boundary,
      // to the tool and its frozen arguments by the request digest, parked on
      // an approval when the category is governed, dispatched once, and
      // answered from its record when the resumed conversation asks again.
      dispatch: async (registry, call) => {
        // The same rule as the direct tool piece: a category cannot describe
        // what a script or a click sequence will do, so it is not approvable
        // here either. The agent learns it was refused.
        if (OPAQUE_TOOL_NAMES.has(call.toolCall.name)) {
          return { kind: 'denied', reason: `Unsupported workflow capability: ${call.toolCall.name} has opaque code/UI effects; use a typed governed adapter.` };
        }
        try {
          const inner = await effects.invoke({ context: ctx, piece: AGENT_PIECE, action: 'delegate',
            route: `agent-tool:${call.sequence}`, toolName: call.toolCall.name, category: call.actionCategory,
            toolCategory: call.toolCategory, request: { toolName: call.toolCall.name, arguments: call.toolCall.arguments },
            // Judged as the sub-agent the gate judged it for, and never
            // concluded to need less than the gate required.
            principal: call.principal, approvalRequired: true,
            // The target names who asked, so the card and the record are bound
            // to the principal and not only to the tool.
            prepare: () => ({ arguments: { ...call.toolCall.arguments }, target: { tool: call.toolCall.name, sequence: call.sequence,
              principal: { agentId: call.principal.agentId, agentRoleId: call.principal.agentRoleId, agentAuthorityLevel: call.principal.agentAuthorityLevel } } }),
            execute: async (args, checkpoint) => {
              checkpoint();
              try {
                const raw = await registry.execute(call.toolCall.name, args);
                return typeof raw === 'string' ? raw : JSON.stringify(raw);
              } catch (error) {
                // A tool that failed under its approval is a typed failure, so
                // the boundary records the outcome and answers the same way
                // when the resumed conversation asks again.
                if (error instanceof ActionOutcomeError) throw error;
                throw new ActionOutcomeError({ status: 'error', code: 'TOOL_FAILED', effect: 'may_have_occurred',
                  message: `Error executing ${call.toolCall.name}: ${error instanceof Error ? error.message : String(error)}` });
              }
            } });
          if (inner.approval) return { kind: 'paused', approval: inner.approval };
          return { kind: 'executed', result: String(inner.result ?? '') };
        } catch (error) {
          // The record the boundary left decides what the agent sees, never
          // the message: a blocked effect (the user's decision, an Authority
          // refusal for this principal, emergency state, a refused target) is
          // a denial, a failed one a failure the agent continues from. A
          // refusal that left no final record (a changed version, an
          // uncertain or already claimed earlier attempt) is this run's
          // error, not the delegation's.
          const message = error instanceof Error ? error.message : String(error);
          const recorded = getWorkflowEffect(workflowEffectId(resolved.run.id, resolved.stepName, resolved.executionPath, `agent-tool:${call.sequence}`));
          if (recorded?.status === 'blocked') return { kind: 'denied', reason: recorded.error ?? message };
          if (recorded?.status === 'failed' || recorded?.status === 'unknown') return { kind: 'failed', result: recorded.error ?? message };
          throw error;
        }
      },
    };
    return m7.delegate(req, continuation);
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

  /**
   * Admission for a verified piece's action. The piece itself runs in the
   * engine subprocess, so what passes through the boundary here is the
   * decision to let it dispatch: the same Authority check, the same emergency
   * and cancellation fences, the same durable record, audit row and approval
   * waitpoint every other effect gets. The remote call happens in the
   * subprocess once this returns, so the record is a dispatch authorization
   * and not a completion receipt.
   *
   * A piece with no adapter is reported ungoverned and runs as it does today.
   *
   * One authorization covers one step instance. A step the flow configures to
   * retry re-reads the recorded authorization for the same arguments instead
   * of asking again, so the engine's own retry of a step whose remote call
   * failed can repeat that call under the original decision. Any change to the
   * arguments, the version or the Authority decision invalidates the record and
   * stops the dispatch.
   */
  const pieceAuthorize: PieceAuthorizeFn = async (req, ctx) => {
    const resolved = resolveGovernedPieceAction(req.piece, req.action);
    if (!resolved) return { governed: false };
    // The connection is stripped on the engine side before the input is sent;
    // stripping it again here means neither path can put a credential into the
    // durable record or the approval card.
    const input = sanitizePieceInput(req.input);
    const tool = governedPieceToolDefinition(resolved);
    const capability = (() => {
      try { return toolEffectCapability(tool); }
      catch (error) {
        effects.auditRefusal({ context: ctx, toolName: tool.name, category: refusedEffectCategory(tool) });
        throw error;
      }
    })();
    const reply = await effects.invoke({ context: ctx, piece: req.piece, action: req.action,
      route: 'piece', toolName: tool.name, category: capability.category, toolCategory: tool.category,
      // Digested over the whole resolved input, so a change to any prop -- not
      // just the ones the card shows -- invalidates an approval granted earlier.
      request: { piece: req.piece, action: req.action, input },
      prepare: () => ({ arguments: input, target: capability.target(input) }),
      validateTarget: (_args, target) => {
        if (digest(capability.target(input)) !== digest(target)) throw new Error('Workflow execution target changed after review; dispatch blocked');
      },
      execute: async (_args, checkpoint) => { checkpoint(); return { dispatch: 'authorized' }; } });
    return reply.approval ? { governed: true, dispatch: 'approval_required', approval: reply.approval }
      : { governed: true, dispatch: 'authorized' };
  };

  const services: SandboxApiServices = {
    credentialResolver: opts.credentialResolver,
    pieceAuthorize: cancellableWorkflowService(pieceAuthorize),
    llmChat: cancellableWorkflowService(llmChat),
    notify: cancellableWorkflowService(notify),
    contextProvider,
    agentDelegate: cancellableWorkflowService((req, ctx) => withWorkflowMachineBinding(ctx, () => agentDelegate(req, ctx))),
    eventsPoll,
    workflowsStart: cancellableWorkflowService(workflowsStart),
    ...(opts.resumeUrlPrefix !== undefined ? { resumeUrlPrefix: opts.resumeUrlPrefix } : {}),
  };
  if (toolsInvoke) services.toolsInvoke = cancellableWorkflowService((req, ctx) => withWorkflowMachineBinding(ctx, () => toolsInvoke(req, ctx)));
  return services;
}
