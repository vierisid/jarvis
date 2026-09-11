/**
 * Delegate Task Tool — Multi-Agent Delegation
 *
 * Allows the primary agent (PA) to delegate tasks to specialist sub-agents.
 * The tool spawns a specialist, runs it through a full LLM+tool loop,
 * and returns the result to the PA.
 *
 * Supports sync mode (tool blocks until done) and async mode (background).
 */

import type { AgentOrchestrator } from '../../agents/orchestrator.ts';
import type { LLMManager } from '../../llm/manager.ts';
import type { RoleDefinition } from '../../roles/types.ts';
import type { ToolDefinition } from './registry.ts';
import { runSubAgent, createScopedToolRegistry, type ProgressCallback } from '../../agents/sub-agent-runner.ts';

export type DelegateToolDeps = {
  orchestrator: AgentOrchestrator;
  llmManager: LLMManager;
  specialists: Map<string, RoleDefinition>;
  onProgress?: ProgressCallback;
  onDelegation?: (specialistName: string, task: string) => void;
};

/**
 * Create the delegate_task tool definition.
 * The deps are captured in the closure so the tool has access at execution time.
 */
export function createDelegateTool(deps: DelegateToolDeps): ToolDefinition {
  return {
    name: 'delegate_task',
    description: [
      'Quick sync delegation: spawns a specialist, runs the task to completion, returns the result.',
      'The specialist has its own LLM and tools. Blocks until done — use for focused, quick tasks.',
      'For persistent agents or parallel work, use manage_agents instead.',
      '',
      'Available specialists: ' + Array.from(deps.specialists.keys()).join(', '),
    ].join('\n'),
    category: 'delegation',
    parameters: {
      specialist: {
        type: 'string',
        description: 'The specialist role ID to delegate to (e.g., "research-analyst", "software-engineer")',
        required: true,
      },
      task: {
        type: 'string',
        description: 'Clear description of what the specialist should do',
        required: true,
      },
      context: {
        type: 'string',
        description: 'Background information, relevant details, or constraints for the task',
        required: true,
      },
    },
    execute: async (params) => {
      const specialistId = params.specialist as string;
      const task = params.task as string;
      const context = params.context as string;

      // Validate specialist exists
      const specialistRole = deps.specialists.get(specialistId);
      if (!specialistRole) {
        const available = Array.from(deps.specialists.keys()).join(', ');
        return `Error: Unknown specialist "${specialistId}". Available: ${available}`;
      }

      // Get the primary agent as parent
      const primary = deps.orchestrator.getPrimary();
      if (!primary) {
        return 'Error: No primary agent exists to delegate from';
      }

      console.log(`[DelegateTool] Delegating to ${specialistRole.name}: ${task.slice(0, 100)}...`);

      // Notify task board: ownership is transferring to specialist
      deps.onDelegation?.(specialistRole.name, task);

      // Notify progress: delegation starting
      if (deps.onProgress) {
        deps.onProgress({
          type: 'text',
          agentName: specialistRole.name,
          agentId: 'pending',
          data: `[Delegating to ${specialistRole.name}...]`,
        });
      }

      // Spawn sub-agent
      const subAgent = deps.orchestrator.spawnSubAgent(primary.id, specialistRole);

      // Create scoped tool registry based on specialist's allowed tools
      const scopedRegistry = createScopedToolRegistry(subAgent.agent.authority.allowed_tools);

      console.log(`[DelegateTool] Spawned ${specialistRole.name} (${subAgent.id}) with ${scopedRegistry.count()} tools`);

      try {
        // Run the sub-agent (sync — blocks until complete)
        // The sub-agent runs under the parent's authority engine and the
        // parent's effective profile (static restrictions plus the taint of
        // the turn that delegated), so delegation is not a way around the
        // gate: governed actions are denied outright in a sub-agent.
        const result = await runSubAgent({
          agent: subAgent,
          task,
          context,
          llmManager: deps.llmManager,
          toolRegistry: scopedRegistry,
          onProgress: deps.onProgress,
          authorityEngine: deps.orchestrator.getAuthorityEngine() ?? undefined,
          auditTrail: deps.orchestrator.getAuditTrail() ?? undefined,
          emergencyController: deps.orchestrator.getEmergencyController() ?? undefined,
          temporaryGrants: deps.orchestrator.getTemporaryGrants(),
          profile: deps.orchestrator.getEffectiveProfile(),
          taintGating: deps.orchestrator.getTaintGating(),
        });

        // Terminate sub-agent after completion
        deps.orchestrator.terminateAgent(subAgent.id);

        // Format result for the PA
        const toolsList = result.toolsUsed.length > 0
          ? `\nTools used: ${result.toolsUsed.join(', ')}`
          : '';
        const tokens = `\nTokens: ${result.tokensUsed.input + result.tokensUsed.output}`;

        if (result.success) {
          return [
            `[${specialistRole.name} completed]`,
            '',
            result.response,
            toolsList,
            tokens,
          ].join('\n');
        } else {
          return [
            `[${specialistRole.name} failed]`,
            '',
            result.response,
            toolsList,
            tokens,
          ].join('\n');
        }
      } catch (err) {
        // Clean up on error
        try {
          deps.orchestrator.terminateAgent(subAgent.id);
        } catch { /* ignore cleanup errors */ }

        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[DelegateTool] Error:`, errorMsg);
        return `Error: Delegation to ${specialistRole.name} failed: ${errorMsg}`;
      }
    },
  };
}
