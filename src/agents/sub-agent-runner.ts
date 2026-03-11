/**
 * Sub-Agent Runner — Generic LLM+Tool Loop
 *
 * Runs any AgentInstance through the LLM+tool execution loop.
 * Mirrors orchestrator.processMessage() but parameterized on agent
 * instead of hardcoded to primary. Supports progress callbacks for
 * real-time streaming to clients.
 */

import type { AgentInstance } from './agent.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { LLMMessage, LLMResponse, LLMToolCall, LLMTool } from '../llm/provider.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { toolDefToLLMTool, BUILTIN_TOOLS } from '../actions/tools/builtin.ts';
import type { ActionCategory } from '../roles/authority.ts';
import type { AuthorityEngine } from '../authority/engine.ts';
import type { AuditTrail } from '../authority/audit.ts';
import type { EmergencyController } from '../authority/emergency.ts';
import { getActionForTool } from '../authority/tool-action-map.ts';

const MAX_TOOL_ITERATIONS = 100; // Lower than primary's 200 — sub-agents should be focused
const MAX_TOOL_RESULT_CHARS = 6000;

export type SubAgentResult = {
  success: boolean;
  response: string;
  toolsUsed: string[];
  tokensUsed: { input: number; output: number };
};

export type ProgressCallback = (event: {
  type: 'text' | 'tool_call' | 'done';
  agentName: string;
  agentId: string;
  data: unknown;
}) => void;

export type RunSubAgentOptions = {
  agent: AgentInstance;
  task: string;
  context: string;
  llmManager: LLMManager;
  toolRegistry: ToolRegistry;
  onProgress?: ProgressCallback;
  maxIterations?: number;
  // Authority engine components (optional — if not provided, no gate applied)
  authorityEngine?: AuthorityEngine;
  auditTrail?: AuditTrail;
  emergencyController?: EmergencyController;
  temporaryGrants?: Map<string, ActionCategory[]>;
};

/**
 * Build a system prompt for a sub-agent from its role definition.
 */
function buildSubAgentPrompt(agent: AgentInstance, context: string): string {
  const role = agent.agent.role;

  const parts = [
    `You are ${role.name}.`,
    '',
    role.description,
    '',
    '## Your Responsibilities',
    ...role.responsibilities.map(r => `- ${r}`),
    '',
    '## Rules',
    '- Focus on completing the specific task assigned to you.',
    '- Use your tools to accomplish the task — don\'t just describe what you would do.',
    '- Be thorough but efficient. Don\'t do unnecessary work.',
    '- Return a clear, structured result when done.',
  ];

  if (context) {
    parts.push('', '## Context', context);
  }

  return parts.join('\n');
}

/**
 * Get LLM-formatted tools from a scoped ToolRegistry.
 */
function getLLMTools(registry: ToolRegistry): LLMTool[] | undefined {
  if (registry.count() === 0) return undefined;
  return registry.list().map(toolDefToLLMTool);
}

/**
 * Execute a single tool call via a ToolRegistry.
 * Includes optional authority gate for sub-agents.
 */
async function executeTool(
  registry: ToolRegistry,
  toolCall: LLMToolCall,
  authorityCtx?: {
    agent: AgentInstance;
    engine: AuthorityEngine;
    auditTrail?: AuditTrail;
    emergencyController?: EmergencyController;
    temporaryGrants?: Map<string, ActionCategory[]>;
  }
): Promise<string> {
  // Authority gate (if engine provided)
  if (authorityCtx) {
    const { agent, engine, auditTrail, emergencyController, temporaryGrants } = authorityCtx;

    // Emergency check
    if (emergencyController && !emergencyController.canExecute()) {
      return `[SYSTEM ${emergencyController.getState().toUpperCase()}] Tool execution suspended.`;
    }

    const tool = registry.get(toolCall.name);
    const actionCategory = getActionForTool(toolCall.name, tool?.category ?? 'unknown');

    const decision = engine.checkAuthority({
      agentId: agent.id,
      agentAuthorityLevel: agent.agent.authority.max_authority_level,
      agentRoleId: agent.agent.role.id,
      toolName: toolCall.name,
      toolCategory: tool?.category ?? 'unknown',
      actionCategory,
      temporaryGrants: temporaryGrants ?? new Map(),
    });

    auditTrail?.log({
      agent_id: agent.id,
      agent_name: agent.agent.role.name,
      tool_name: toolCall.name,
      action_category: actionCategory,
      authority_decision: decision.allowed ? 'allowed' : 'denied',
      executed: decision.allowed,
    });

    if (!decision.allowed) {
      return `[AUTHORITY DENIED] ${toolCall.name}: ${decision.reason}`;
    }

    // Sub-agents don't get approval flow — they're denied outright for governed actions
    if (decision.requiresApproval) {
      return `[AUTHORITY DENIED] ${toolCall.name} requires user approval. Sub-agents cannot request approvals directly.`;
    }
  }

  try {
    const raw = await registry.execute(toolCall.name, toolCall.arguments);
    let result: string = typeof raw === 'string' ? raw : JSON.stringify(raw);

    if (result.length > MAX_TOOL_RESULT_CHARS) {
      result = result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n... (truncated, was ${result.length} chars)`;
    }

    return result;
  } catch (err) {
    return `Error executing ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run a sub-agent through the full LLM+tool execution loop.
 *
 * This is the core engine that powers sub-agent execution.
 * It works exactly like the primary agent's processMessage() loop
 * but operates on any AgentInstance with its own scoped tools.
 */
export async function runSubAgent(opts: RunSubAgentOptions): Promise<SubAgentResult> {
  const {
    agent,
    task,
    context,
    llmManager,
    toolRegistry,
    onProgress,
    maxIterations = MAX_TOOL_ITERATIONS,
    authorityEngine,
    auditTrail,
    emergencyController,
    temporaryGrants,
  } = opts;

  // Build authority context if engine provided
  const authorityCtx = authorityEngine ? {
    agent,
    engine: authorityEngine,
    auditTrail,
    emergencyController,
    temporaryGrants,
  } : undefined;

  const agentName = agent.agent.role.name;
  const agentId = agent.id;
  const toolsUsed: string[] = [];
  const totalUsage = { input: 0, output: 0 };

  // Set the task on the agent
  agent.setTask(task);
  agent.activate();

  // Build system prompt
  const systemPrompt = buildSubAgentPrompt(agent, context);

  // Add the task as a user message
  agent.addMessage('user', task);

  // Build messages array
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...agent.getMessages(),
  ];

  const tools = getLLMTools(toolRegistry);
  let finalText = '';

  try {
    // Tool execution loop
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const llmResponse: LLMResponse = await llmManager.chat(messages, { tools });

      totalUsage.input += llmResponse.usage.input_tokens;
      totalUsage.output += llmResponse.usage.output_tokens;

      if (llmResponse.finish_reason === 'tool_use' && llmResponse.tool_calls.length > 0) {
        // Add assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: llmResponse.content,
          tool_calls: llmResponse.tool_calls,
        });

        // Notify about text if any
        if (llmResponse.content && onProgress) {
          onProgress({ type: 'text', agentName, agentId, data: llmResponse.content });
        }

        // Execute each tool
        for (const tc of llmResponse.tool_calls) {
          toolsUsed.push(tc.name);

          // Notify about tool call
          if (onProgress) {
            onProgress({
              type: 'tool_call',
              agentName,
              agentId,
              data: { name: tc.name, arguments: tc.arguments },
            });
          }

          const result = await executeTool(toolRegistry, tc, authorityCtx);
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
          });

          console.log(`[SubAgent:${agentName}] Tool ${tc.name} -> ${result.slice(0, 100)}...`);
        }

        continue;
      }

      // No tool calls — this is the final response
      finalText = llmResponse.content;

      if (onProgress) {
        onProgress({ type: 'text', agentName, agentId, data: finalText });
        onProgress({ type: 'done', agentName, agentId, data: { tokensUsed: totalUsage } });
      }

      break;
    }

    // Add final response to agent's history
    agent.addMessage('assistant', finalText);

    return {
      success: true,
      response: finalText,
      toolsUsed: [...new Set(toolsUsed)],
      tokensUsed: totalUsage,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[SubAgent:${agentName}] Error:`, errorMsg);

    return {
      success: false,
      response: `Sub-agent error: ${errorMsg}`,
      toolsUsed: [...new Set(toolsUsed)],
      tokensUsed: totalUsage,
    };
  }
}

/**
 * Create a scoped ToolRegistry for a sub-agent.
 * Only includes builtin tools whose category is in the allowed list.
 */
export function createScopedToolRegistry(allowedCategories: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) {
    if (allowedCategories.includes(tool.category)) {
      registry.register(tool);
    }
  }
  return registry;
}
