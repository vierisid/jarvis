import type { ContentBlock } from '../../llm/provider.ts';
import { checkpointExecution } from '../execution-scope.ts';
import { ActionOutcomeError } from '../action-outcome.ts';

export type ToolParameter = {
  type: string;
  description: string;
  required: boolean;
  /**
   * Allowed values for a string parameter. Emitted as JSON-Schema `enum` in
   * the model-facing schema AND enforced in `validateParameters`, so it is a
   * constraint and not just a hint: small and local models routinely invent
   * values when the choices are only described in prose, and an advertised
   * but unchecked enum only moves that failure one layer down, into the
   * sidecar or the provider.
   *
   * Prefer this over listing the options in the description.
   */
  enum?: string[];
};

export type ToolResult = {
  content: ContentBlock[];
};

export function isToolResult(v: unknown): v is ToolResult {
  return v !== null && typeof v === 'object' && 'content' in (v as object) && Array.isArray((v as ToolResult).content);
}

/**
 * Per-call authority resolution for a tool whose effect is decided by what
 * the call will do, not by the tool's name: run_skill replays whatever steps
 * the named skill holds, record_skill installs input hooks.
 *
 *   actionCategory  what this call reaches. The orchestrator gates on the
 *                   stricter of this and the tool's TOOL_ACTION_MAP entry, so
 *                   a gate can raise a call, never lower it below the floor.
 *   intent          card-ready sentence naming what will actually happen,
 *                   with resolved values ("click Send (sends email)").
 *   confirm         'always': the person must confirm this call on a card
 *                   whatever the agent's level. 'above_level': a category the
 *                   agent's level cannot clear becomes an approval card instead
 *                   of a denial, the substitution request_approval makes for a
 *                   declared intent. Absent: the engine's decision stands.
 */
export type ToolGate = {
  actionCategory: import('../../roles/authority').ActionCategory;
  /**
   * What the call acts on, as durable identity: for run_skill the skill's
   * name, version and surface. The workflow effect boundary records it as the
   * effect's target, so an approval reviewed against one version of a skill
   * cannot dispatch another. Plain JSON, no secrets. The boundary owns the
   * target keys its dispatch fence reads and drops any subject key that names
   * one (`tool`, `capability`, `sidecarId`, `selection`, `machineBinding`,
   * `intent`), so a gate cannot retarget a run by naming a key the same way.
   */
  subject?: Record<string, unknown>;
  /**
   * Every category the call reaches when it spans more than one (a skill
   * that clicks controls and sends a message). The call must clear each of
   * them: a config that governs send_message stops such a skill even though
   * control_app is the higher level. Defaults to [actionCategory].
   */
  actionCategories?: import('../../roles/authority').ActionCategory[];
  intent: string;
  confirm?: 'always' | 'above_level';
};

export type ToolDefinition = {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, ToolParameter>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
  /** Trusted adapter declaration, never accepted from workflow/model input. */
  workflowEffect?: {
    category: import('../../roles/authority').ActionCategory;
    target: (params: Record<string, unknown>) => Record<string, unknown>;
  };
  /**
   * Trusted per-call gate, never accepted from model input. Consulted by every
   * authority gate site (orchestrator text and realtime paths, sub-agents)
   * before the engine is asked. Returning null leaves the static mapping in
   * force. Must be cheap and must not act.
   */
  authorityGate?: (params: Record<string, unknown>) => ToolGate | null;
};

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  /** Default working directory for tools like run_command. Set by site builder context. */
  defaultCwd: string | null = null;

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }

    this.validateToolDefinition(tool);
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(category?: string): ToolDefinition[] {
    const allTools = Array.from(this.tools.values());

    if (!category) {
      return allTools;
    }

    return allTools.filter(tool => tool.category === category);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(`Tool '${name}' not found in registry`);
    }

    this.validateParameters(tool, params);

    // Outside the try: a cancellation fence is not a tool failure, and
    // rewrapping it would hide its type from the callers that map it.
    checkpointExecution();

    try {
      return await tool.execute(params);
    } catch (error) {
      if (error instanceof ActionOutcomeError) throw error;
      throw new Error(
        `Tool '${name}' execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }

  getCategories(): string[] {
    const categories = new Set<string>();

    for (const tool of this.tools.values()) {
      categories.add(tool.category);
    }

    return Array.from(categories).sort();
  }

  count(): number {
    return this.tools.size;
  }

  private validateToolDefinition(tool: ToolDefinition): void {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('Tool must have a valid name');
    }

    if (!tool.description || typeof tool.description !== 'string') {
      throw new Error(`Tool '${tool.name}' must have a description`);
    }

    if (!tool.category || typeof tool.category !== 'string') {
      throw new Error(`Tool '${tool.name}' must have a category`);
    }

    if (typeof tool.execute !== 'function') {
      throw new Error(`Tool '${tool.name}' must have an execute function`);
    }

    if (typeof tool.parameters !== 'object' || tool.parameters === null) {
      throw new Error(`Tool '${tool.name}' must have a parameters object`);
    }

    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      if (!paramDef.type || typeof paramDef.type !== 'string') {
        throw new Error(`Parameter '${paramName}' in tool '${tool.name}' must have a type`);
      }

      if (!paramDef.description || typeof paramDef.description !== 'string') {
        throw new Error(`Parameter '${paramName}' in tool '${tool.name}' must have a description`);
      }

      if (typeof paramDef.required !== 'boolean') {
        throw new Error(`Parameter '${paramName}' in tool '${tool.name}' must specify if it's required`);
      }

      // `validateParameters` can only enforce an enum on a string value, so a
      // declared enum anywhere else would advertise a constraint that is
      // never checked. Fail at registration instead of shipping the no-op.
      if (paramDef.enum !== undefined) {
        if (!Array.isArray(paramDef.enum) || paramDef.enum.length === 0) {
          throw new Error(`Parameter '${paramName}' in tool '${tool.name}' has an empty enum`);
        }
        if (paramDef.type.toLowerCase() !== 'string') {
          throw new Error(
            `Parameter '${paramName}' in tool '${tool.name}' declares an enum but is type '${paramDef.type}'; enums are only enforced for strings`
          );
        }
        if (paramDef.enum.some((v) => typeof v !== 'string')) {
          throw new Error(`Parameter '${paramName}' in tool '${tool.name}' has a non-string enum value`);
        }
      }
    }
  }

  private validateParameters(tool: ToolDefinition, params: Record<string, unknown>): void {
    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      const value = params[paramName];

      if (paramDef.required && (value === undefined || value === null)) {
        throw new Error(`Required parameter '${paramName}' missing for tool '${tool.name}'`);
      }

      if (value !== undefined && value !== null) {
        const actualType = typeof value;
        const expectedType = paramDef.type.toLowerCase();

        if (expectedType === 'array' && !Array.isArray(value)) {
          throw new Error(
            `Parameter '${paramName}' for tool '${tool.name}' must be an array, got ${actualType}`
          );
        } else if (expectedType === 'object' && (actualType !== 'object' || Array.isArray(value))) {
          throw new Error(
            `Parameter '${paramName}' for tool '${tool.name}' must be an object, got ${actualType}`
          );
        } else if (
          expectedType !== 'array' &&
          expectedType !== 'object' &&
          actualType !== expectedType &&
          !(expectedType === 'number' && actualType === 'bigint')
        ) {
          throw new Error(
            `Parameter '${paramName}' for tool '${tool.name}' must be ${expectedType}, got ${actualType}`
          );
        }

        // An out-of-enum value is rejected here, with the allowed values in
        // the message: the orchestrator turns a throw into the tool result
        // the model reads, so an invented action gets corrected on the next
        // turn instead of reaching the sidecar as an opaque failure.
        //
        // Matched case-insensitively on purpose. Callers that already worked
        // keep working (`parsePostcondition` lowercases its input, and stored
        // workflow steps were written before any enum existed), and the value
        // is passed through unchanged rather than normalised, so this only
        // ever narrows what is rejected -- it never alters what a tool sees.
        if (paramDef.enum && paramDef.enum.length > 0 && typeof value === 'string') {
          const allowed = paramDef.enum;
          if (!allowed.some((v) => v.toLowerCase() === value.toLowerCase())) {
            throw new Error(
              `Parameter '${paramName}' for tool '${tool.name}' must be one of: ${allowed.join(', ')} (got "${value}")`
            );
          }
        }
      }
    }

    const unexpectedParams = Object.keys(params).filter(key => !tool.parameters[key]);
    if (unexpectedParams.length > 0) {
      console.warn(
        `Unexpected parameters for tool '${tool.name}': ${unexpectedParams.join(', ')}`
      );
    }
  }
}
