import type { ContentBlock } from '../../llm/provider.ts';

export type ToolParameter = {
  type: string;
  description: string;
  required: boolean;
};

export type ToolResult = {
  content: ContentBlock[];
};

export function isToolResult(v: unknown): v is ToolResult {
  return v !== null && typeof v === 'object' && 'content' in (v as object) && Array.isArray((v as ToolResult).content);
}

export type ToolDefinition = {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, ToolParameter>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
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

    try {
      return await tool.execute(params);
    } catch (error) {
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
