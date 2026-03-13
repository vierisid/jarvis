import type { RoleDefinition } from '../roles/types.ts';
import type { LLMMessage, LLMResponse, LLMStreamEvent, LLMToolCall, LLMTool, ContentBlock } from '../llm/provider.ts';
import { guardImageSize } from '../llm/provider.ts';
import { LLMManager } from '../llm/manager.ts';
import { AgentInstance } from './agent.ts';
import { AgentHierarchy } from './hierarchy.ts';
import { ToolRegistry, type ToolDefinition, isToolResult } from '../actions/tools/registry.ts';
import { toolDefToLLMTool } from '../actions/tools/builtin.ts';
import type { ActionCategory } from '../roles/authority.ts';
import type { AuthorityEngine } from '../authority/engine.ts';
import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';
import type { AuditTrail } from '../authority/audit.ts';
import type { EmergencyController } from '../authority/emergency.ts';
import { getActionForTool } from '../authority/tool-action-map.ts';

const MAX_TOOL_ITERATIONS = 200;
const MAX_TOOL_RESULT_CHARS = 6000; // Cap individual tool results to control context size

export class AgentOrchestrator {
  private hierarchy: AgentHierarchy;
  private llmManager: LLMManager | null;
  private toolRegistry: ToolRegistry | null;

  // Authority engine components
  private authorityEngine: AuthorityEngine | null = null;
  private approvalManager: ApprovalManager | null = null;
  private auditTrail: AuditTrail | null = null;
  private emergencyController: EmergencyController | null = null;
  private temporaryGrants: Map<string, ActionCategory[]> = new Map();
  private onApprovalNeeded: ((request: ApprovalRequest) => void) | null = null;

  constructor() {
    this.hierarchy = new AgentHierarchy();
    this.llmManager = null;
    this.toolRegistry = null;
  }

  setLLMManager(llm: LLMManager): void {
    this.llmManager = llm;
  }

  getLLMManager(): LLMManager | null {
    return this.llmManager;
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  getToolRegistry(): ToolRegistry | null {
    return this.toolRegistry;
  }

  // --- Authority setters ---

  setAuthorityEngine(engine: AuthorityEngine): void {
    this.authorityEngine = engine;
  }

  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
  }

  setAuditTrail(trail: AuditTrail): void {
    this.auditTrail = trail;
  }

  setEmergencyController(controller: EmergencyController): void {
    this.emergencyController = controller;
  }

  setApprovalCallback(cb: (request: ApprovalRequest) => void): void {
    this.onApprovalNeeded = cb;
  }

  /**
   * Grant a temporary permission to a specific agent (for parent escalation).
   */
  grantTemporary(agentId: string, action: ActionCategory): void {
    const existing = this.temporaryGrants.get(agentId) ?? [];
    if (!existing.includes(action)) {
      existing.push(action);
      this.temporaryGrants.set(agentId, existing);
    }
  }

  /**
   * Revoke a temporary permission from an agent.
   */
  revokeTemporary(agentId: string, action: ActionCategory): void {
    const existing = this.temporaryGrants.get(agentId);
    if (existing) {
      this.temporaryGrants.set(agentId, existing.filter(a => a !== action));
    }
  }

  /**
   * Clear all temporary grants for an agent (called when task completes).
   */
  clearTemporaryGrants(agentId: string): void {
    this.temporaryGrants.delete(agentId);
  }

  /**
   * Create the primary agent from a role.
   * No inline system prompt — the AgentService builds a rich dynamic prompt each turn.
   */
  createPrimary(role: RoleDefinition): AgentInstance {
    const existing = this.hierarchy.getPrimary();
    if (existing) {
      throw new Error('Primary agent already exists. Terminate it first.');
    }

    const agent = new AgentInstance(role);
    this.hierarchy.addAgent(agent);
    return agent;
  }

  /**
   * Spawn a sub-agent under a parent
   */
  spawnSubAgent(
    parentId: string,
    role: RoleDefinition,
    opts?: { memory_scope?: string[] }
  ): AgentInstance {
    const parent = this.hierarchy.getAgent(parentId);
    if (!parent) {
      throw new Error(`Parent agent not found: ${parentId}`);
    }

    if (!parent.agent.authority.can_spawn_children) {
      throw new Error('Parent agent does not have authority to spawn children');
    }

    // Create child agent with reduced authority
    const childAuthority = {
      max_authority_level: Math.min(
        role.authority_level,
        parent.agent.authority.max_authority_level - 1
      ),
      allowed_tools: role.tools.filter((tool) =>
        parent.agent.authority.allowed_tools.includes(tool)
      ),
      denied_tools: parent.agent.authority.denied_tools,
      max_token_budget: Math.floor(parent.agent.authority.max_token_budget / 2),
      can_spawn_children: role.sub_roles.length > 0,
    };

    const agent = new AgentInstance(role, {
      parent_id: parentId,
      authority: childAuthority,
      memory_scope: opts?.memory_scope ?? [],
    });

    this.hierarchy.addAgent(agent);

    // Add system message with role context for sub-agents
    agent.addMessage(
      'system',
      `You are ${role.name}, spawned by ${parent.agent.role.name}. ${role.description}\n\nResponsibilities:\n${role.responsibilities.map((r) => `- ${r}`).join('\n')}\n\nYou report to: ${parent.agent.role.name}\n\nCommunication style: ${role.communication_style.tone} tone, ${role.communication_style.verbosity} verbosity, ${role.communication_style.formality} formality.`
    );

    return agent;
  }

  /**
   * Terminate an agent and its children
   */
  terminateAgent(agentId: string): void {
    const agent = this.hierarchy.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Recursively terminate children first
    const children = this.hierarchy.getChildren(agentId);
    for (const child of children) {
      this.terminateAgent(child.id);
    }

    // Terminate this agent
    agent.terminate();
    this.hierarchy.removeAgent(agentId);
  }

  getPrimary(): AgentInstance | undefined {
    return this.hierarchy.getPrimary();
  }

  getAgent(agentId: string): AgentInstance | undefined {
    return this.hierarchy.getAgent(agentId);
  }

  getAllAgents(): AgentInstance[] {
    return this.hierarchy.getAllAgents();
  }

  getHierarchy(): AgentHierarchy {
    return this.hierarchy;
  }

  /**
   * Process a user message through the primary agent (non-streaming).
   * Includes the tool execution loop: LLM → tool_calls → execute → re-call → repeat.
   */
  async processMessage(systemPrompt: string, message: string): Promise<string> {
    const primary = this.getPrimary();
    if (!primary) {
      throw new Error('No primary agent exists. Create one first.');
    }

    // Add user message to persistent history
    primary.addMessage('user', message);

    // If no LLM manager, return placeholder
    if (!this.llmManager) {
      const response = `[No LLM configured] Received: ${message}`;
      primary.addMessage('assistant', response);
      return response;
    }

    // Build local messages array for this turn (system + history)
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...primary.getMessages(),
    ];

    const tools = this.getLLMTools();
    let finalText = '';

    // Tool execution loop
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const llmResponse: LLMResponse = await this.llmManager.chat(messages, { tools });

      if (llmResponse.finish_reason === 'tool_use' && llmResponse.tool_calls.length > 0) {
        // Add assistant message with tool calls to local messages
        messages.push({
          role: 'assistant',
          content: llmResponse.content,
          tool_calls: llmResponse.tool_calls,
        });

        // Execute each tool and add results
        for (const tc of llmResponse.tool_calls) {
          const result = await this.executeTool(tc);
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
          });
          const logStr = typeof result === 'string' ? result.slice(0, 100) : `[${result.length} content blocks]`;
          console.log(`[Orchestrator] Tool ${tc.name} → ${logStr}...`);

          // Capture document markers so they appear in the final response
          if (typeof result === 'string') {
            const docMarker = result.match(/<!-- jarvis:document id="[^"]+" title="[^"]+" format="[^"]+" size="[^"]+" -->/);
            if (docMarker) {
              finalText += '\n' + docMarker[0] + '\n';
            }
          }
        }

        // Continue loop to re-call LLM with tool results
        continue;
      }

      // No tool calls — this is the final response
      finalText = llmResponse.content;

      // Warn on truncation
      if (llmResponse.finish_reason === 'length') {
        finalText += '\n\n[Response was truncated due to output token limits. If you asked for long content, ask to continue or use shorter chunks.]';
      }

      break;
    }

    // Add final response to persistent history
    primary.addMessage('assistant', finalText);
    return finalText;
  }

  /**
   * Stream a message through the primary agent with tool execution loop.
   * Yields text/tool_call events through all iterations.
   * Only emits 'done' when the final response is complete.
   */
  async *streamMessage(systemPrompt: string, message: string): AsyncIterable<LLMStreamEvent> {
    const primary = this.getPrimary();
    if (!primary) {
      throw new Error('No primary agent exists. Create one first.');
    }

    // Add user message to persistent history
    primary.addMessage('user', message);

    // If no LLM manager, yield placeholder
    if (!this.llmManager) {
      const response = `[No LLM configured] Received: ${message}`;
      primary.addMessage('assistant', response);
      yield { type: 'text', text: response };
      yield {
        type: 'done',
        response: {
          content: response,
          tool_calls: [],
          usage: { input_tokens: 0, output_tokens: 0 },
          model: 'none',
          finish_reason: 'stop',
        },
      };
      return;
    }

    // Build local messages array for this turn
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...primary.getMessages(),
    ];

    const tools = this.getLLMTools();
    const totalUsage = { input_tokens: 0, output_tokens: 0 };
    let finalText = '';
    let responseModel = 'unknown';

    // Tool execution loop
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      let accumulatedText = '';
      const toolCalls: LLMToolCall[] = [];
      let doneResponse: LLMResponse | null = null;

      // Stream from LLM
      for await (const event of this.llmManager.stream(messages, { tools })) {
        if (event.type === 'text') {
          accumulatedText += event.text;
          yield event; // Forward text chunks to client
        } else if (event.type === 'tool_call') {
          toolCalls.push(event.tool_call);
          yield event; // Forward tool_call events to client
        } else if (event.type === 'done') {
          doneResponse = event.response;
          totalUsage.input_tokens += event.response.usage.input_tokens;
          totalUsage.output_tokens += event.response.usage.output_tokens;
          responseModel = event.response.model;
          // Don't yield done yet — may need more iterations
        } else if (event.type === 'error') {
          yield event;
          return;
        }
      }

      // Ensure doneResponse is never null (stream may end without 'done' event)
      if (!doneResponse) {
        doneResponse = {
          content: accumulatedText,
          tool_calls: toolCalls,
          usage: { input_tokens: 0, output_tokens: 0 },
          model: responseModel,
          finish_reason: 'stop',
        };
      }

      // No tool calls — this is the final response
      if (toolCalls.length === 0) {
        finalText += accumulatedText;

        // Check if we stopped due to token limit (truncation)
        const wasLength = doneResponse?.finish_reason === 'length';
        if (wasLength && !finalText.includes('[SYSTEM WARNING')) {
          const truncWarning = '\n\n[Response was truncated due to output token limits. If you asked for long content, ask to continue or use shorter chunks.]';
          finalText += truncWarning;
          yield { type: 'text', text: truncWarning };
        }

        yield {
          type: 'done',
          response: {
            content: finalText,
            tool_calls: [],
            usage: totalUsage,
            model: responseModel,
            finish_reason: wasLength ? 'length' : 'stop',
          },
        };
        // Add final response to persistent history (only user-facing text)
        primary.addMessage('assistant', finalText);
        return;
      }

      // Tool calls present — execute them
      finalText += accumulatedText;

      // Add assistant message with tool calls to local messages
      messages.push({
        role: 'assistant',
        content: accumulatedText,
        tool_calls: toolCalls,
      });

      // Execute each tool and add results
      for (const tc of toolCalls) {
        const result = await this.executeTool(tc);
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
        const logStr = typeof result === 'string' ? result.slice(0, 100) : `[${result.length} content blocks]`;
        console.log(`[Orchestrator] Tool ${tc.name} → ${logStr}...`);

        // Inject document markers into the stream so the UI can render download cards
        if (typeof result === 'string') {
          const docMarker = result.match(/<!-- jarvis:document id="[^"]+" title="[^"]+" format="[^"]+" size="[^"]+" -->/);
          if (docMarker) {
            yield { type: 'text' as const, text: '\n' + docMarker[0] + '\n' };
          }
        }
      }

      // Continue loop — will stream next LLM response
    }

    // Max iterations reached
    yield { type: 'text', text: '\n[Max tool iterations reached]' };
    yield {
      type: 'done',
      response: {
        content: finalText + '\n[Max tool iterations reached]',
        tool_calls: [],
        usage: totalUsage,
        model: responseModel,
        finish_reason: 'stop',
      },
    };
    primary.addMessage('assistant', finalText);
  }

  /**
   * Heartbeat: let the primary agent check for proactive actions.
   */
  async heartbeat(systemPrompt: string): Promise<string | null> {
    const primary = this.getPrimary();
    if (!primary || !this.llmManager) {
      return null;
    }

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...primary.getMessages(),
    ];

    const llmResponse: LLMResponse = await this.llmManager.chat(messages);

    if (llmResponse.content && llmResponse.content.trim().length > 0) {
      primary.addMessage('assistant', llmResponse.content);
      return llmResponse.content;
    }

    return null;
  }

  // --- Private helpers ---

  /**
   * Get LLM-formatted tools from the ToolRegistry.
   */
  private getLLMTools(): LLMTool[] | undefined {
    if (!this.toolRegistry || this.toolRegistry.count() === 0) {
      return undefined;
    }

    return this.toolRegistry.list().map(toolDefToLLMTool);
  }

  /**
   * Execute a single tool call via the ToolRegistry.
   * Includes authority gate: checks emergency state, authority level, and governed categories.
   * Returns a string for text-only results, or ContentBlock[] for multi-modal results (images).
   */
  private async executeTool(toolCall: LLMToolCall): Promise<string | ContentBlock[]> {
    if (!this.toolRegistry) {
      return `Error: No tool registry configured`;
    }

    // --- Authority Gate ---

    // 1. Emergency check
    if (this.emergencyController && !this.emergencyController.canExecute()) {
      const state = this.emergencyController.getState();
      return `[SYSTEM ${state.toUpperCase()}] All tool execution is currently suspended. The user has ${state} the system.`;
    }

    // 2. Authority check
    const primary = this.getPrimary();
    if (this.authorityEngine && primary) {
      const tool = this.toolRegistry.get(toolCall.name);
      const actionCategory = getActionForTool(toolCall.name, tool?.category ?? 'unknown');

      const decision = this.authorityEngine.checkAuthority({
        agentId: primary.id,
        agentAuthorityLevel: primary.agent.authority.max_authority_level,
        agentRoleId: primary.agent.role.id,
        toolName: toolCall.name,
        toolCategory: tool?.category ?? 'unknown',
        actionCategory,
        temporaryGrants: this.temporaryGrants,
      });

      // Determine decision type for audit
      const decisionType = decision.allowed
        ? (decision.requiresApproval ? 'approval_required' as const : 'allowed' as const)
        : 'denied' as const;

      // 3. Log to audit trail
      this.auditTrail?.log({
        agent_id: primary.id,
        agent_name: primary.agent.role.name,
        tool_name: toolCall.name,
        action_category: actionCategory,
        authority_decision: decisionType,
        approval_id: null,
        executed: decision.allowed && !decision.requiresApproval,
        execution_time_ms: null,
      });

      // 4. Denied
      if (!decision.allowed) {
        return `[AUTHORITY DENIED] Cannot execute ${toolCall.name}: ${decision.reason}. Your authority level is insufficient for ${actionCategory} actions.`;
      }

      // 5. Requires approval
      if (decision.requiresApproval && this.approvalManager) {
        const urgency = this.determineUrgency(actionCategory);
        const request = this.approvalManager.createRequest({
          agentId: primary.id,
          agentName: primary.agent.role.name,
          toolName: toolCall.name,
          toolArguments: toolCall.arguments,
          actionCategory,
          urgency,
          reason: decision.reason,
          context: `Agent attempted: ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
        });

        // Emit approval request event
        this.onApprovalNeeded?.(request);

        return `[AWAITING_APPROVAL] Request #${request.id.slice(0, 8)} submitted. ` +
               `Action: ${toolCall.name} (${actionCategory}). ` +
               `Reason: ${decision.reason}. ` +
               `The user will be notified and can approve or deny this action.`;
      }
    }

    // --- Normal execution ---
    try {
      const startTime = Date.now();
      const raw = await this.toolRegistry.execute(toolCall.name, toolCall.arguments);
      const executionTimeMs = Date.now() - startTime;

      // Update audit entry with execution time (for allowed actions)
      // We already logged above; for simplicity we log execution separately if needed

      // Multi-modal result (e.g. screenshot with image data)
      if (isToolResult(raw)) {
        return raw.content.map(guardImageSize);
      }

      // Plain text result
      let result = typeof raw === 'string' ? raw : JSON.stringify(raw);

      // Cap tool result size to control context growth
      if (result.length > MAX_TOOL_RESULT_CHARS) {
        result = result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n... (truncated, was ${result.length} chars)`;
      }

      return result;
    } catch (err) {
      return `Error executing ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Determine urgency for an approval request based on action category.
   */
  private determineUrgency(actionCategory: ActionCategory): 'urgent' | 'normal' {
    // Financial actions are always urgent
    if (actionCategory === 'make_payment') return 'urgent';
    return 'normal';
  }
}
