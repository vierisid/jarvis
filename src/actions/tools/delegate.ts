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
import type { ToolDefinition, ToolGate } from './registry.ts';
import { runSubAgent, createScopedToolRegistry, type ProgressCallback } from '../../agents/sub-agent-runner.ts';
import { forCard, withoutCardInvisibles } from '../../util/card-text.ts';
import { AGENT_CONTEXT_MAX_CHARS, AGENT_TASK_MAX_CHARS, checkSpecialistId, checkTaskBounds, SPECIALIST_ID_MAX_CHARS } from './agents.ts';

export type DelegateToolDeps = {
  orchestrator: AgentOrchestrator;
  llmManager: LLMManager;
  specialists: Map<string, RoleDefinition>;
  onProgress?: ProgressCallback;
  onDelegation?: (specialistName: string, task: string) => void;
};

/**
 * The card sentence for a delegation (#990): which specialist, and the task
 * and context it will be given. Without one the card read "Delegate task",
 * the defect #932's review fixed for `manage_agents spawn`, so a person
 * approved a task they never saw. Built as `manageAgentsGate` builds a spawn's:
 * values quoted with their quotes escaped, the free-text task last, each in
 * the budget `execute` holds it to, so nothing a card cuts is ever run. The
 * approval executor refuses a run whose recomputed sentence differs from the
 * approved one.
 */
export function delegateTaskGate(params: Record<string, unknown>): ToolGate {
  const quoted = (v: unknown, max: number) => JSON.stringify(forCard(v, max));
  const who = `Delegate to a ${forCard(params.specialist, SPECIALIST_ID_MAX_CHARS) || 'specialist'} specialist`;
  const task = typeof params.task === 'string' && params.task.trim() ? params.task : null;
  const context = typeof params.context === 'string' && params.context.trim() ? params.context : null;
  const withContext = context ? ` with context ${quoted(context, AGENT_CONTEXT_MAX_CHARS)}` : '';
  return { actionCategory: 'spawn_agent', intent: task ? `${who}${withContext} the task ${quoted(task, AGENT_TASK_MAX_CHARS)}` : who };
}

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
    authorityGate: delegateTaskGate,
    parameters: {
      specialist: {
        type: 'string',
        description: 'The specialist role ID to delegate to (e.g., "research-analyst", "software-engineer")',
        required: true,
      },
      task: {
        type: 'string',
        description: `Clear description of what the specialist should do, at most ${AGENT_TASK_MAX_CHARS} characters`,
        required: true,
      },
      context: {
        type: 'string',
        description: `Background information, relevant details, or constraints for the task, at most ${AGENT_CONTEXT_MAX_CHARS} characters`,
        required: true,
      },
    },
    execute: async (params) => {
      const specialistId = params.specialist as string;
      // What runs is what the card showed (#990): without the characters a
      // card cannot display (tag characters spell hidden ASCII), and no
      // longer than the card shows in full. Refused, not cut, as a spawn is.
      const task = typeof params.task === 'string' ? withoutCardInvisibles(params.task) : params.task as string;
      const context = typeof params.context === 'string' ? withoutCardInvisibles(params.context) : params.context as string;
      try {
        checkTaskBounds(task, context);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Validate specialist exists
      const specialistRole = deps.specialists.get(specialistId);
      if (!specialistRole) {
        const available = Array.from(deps.specialists.keys()).join(', ');
        return `Error: Unknown specialist "${specialistId}". Available: ${available}`;
      }
      // And it is the one the card named (#1019).
      try {
        checkSpecialistId(specialistId);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
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
      // Named for the sink's context rules, as the tool layer judged it. No
      // arguments: a synchronous delegation is not re-runnable from a card,
      // so a spawn that still needs approval here is refused, not queued.
      const subAgent = deps.orchestrator.spawnSubAgent(primary.id, specialistRole, { via: { toolName: 'delegate_task' } });

      // Create scoped tool registry based on specialist's allowed tools
      const scopedRegistry = createScopedToolRegistry(subAgent.agent.authority.allowed_tools);

      console.log(`[DelegateTool] Spawned ${specialistRole.name} (${subAgent.id}) with ${scopedRegistry.count()} tools`);

      try {
        // Run the sub-agent (sync — blocks until complete)
        // The sub-agent runs under the parent's authority engine and the
        // parent's effective profile (static restrictions plus the taint of
        // the turn that delegated), so delegation is not a way around the
        // gate: governed actions are denied outright in a sub-agent. When a
        // sub-agent is the one delegating, its restrictions and taint are
        // added (#1014): the specialist never runs under less than it.
        const result = await runSubAgent({
          agent: subAgent,
          task,
          context,
          llmManager: deps.llmManager,
          toolRegistry: scopedRegistry,
          // Provider kinds for the relevance filter's eligibility gate, so a
          // sub-agent classifies its model the way the parent loop does.
          toolFilterProviders: deps.orchestrator.getToolFilterProviders?.(),
          onProgress: deps.onProgress,
          authorityEngine: deps.orchestrator.getAuthorityEngine() ?? undefined,
          auditTrail: deps.orchestrator.getAuditTrail() ?? undefined,
          emergencyController: deps.orchestrator.getEmergencyController() ?? undefined,
          temporaryGrants: deps.orchestrator.getTemporaryGrants(),
          profile: deps.orchestrator.getProfileFor(subAgent.id),
          taintGating: deps.orchestrator.getTaintGating(),
        });

        // Terminate sub-agent after completion
        deps.orchestrator.reapAgent(subAgent.id);

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
          deps.orchestrator.reapAgent(subAgent.id);
        } catch { /* ignore cleanup errors */ }

        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[DelegateTool] Error:`, errorMsg);
        return `Error: Delegation to ${specialistRole.name} failed: ${errorMsg}`;
      }
    },
  };
}
