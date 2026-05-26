import type { RoleDefinition } from '../roles/types.ts';
import type { LLMMessage } from '../llm/provider.ts';

export type AgentStatus = 'active' | 'idle' | 'terminated';

export type AuthorityBounds = {
  max_authority_level: number;
  allowed_tools: string[];
  denied_tools: string[];
  max_token_budget: number;
  can_spawn_children: boolean;
};

export type Agent = {
  id: string;
  role: RoleDefinition;
  parent_id: string | null;
  status: AgentStatus;
  session_id: string;
  current_task: string | null;
  authority: AuthorityBounds;
  memory_scope: string[];
  created_at: number;
};

/**
 * Default authority bounds for an agent
 */
function getDefaultAuthority(role: RoleDefinition): AuthorityBounds {
  return {
    max_authority_level: role.authority_level,
    allowed_tools: role.tools,
    denied_tools: [],
    max_token_budget: 100000,
    can_spawn_children: (role.sub_roles?.length ?? 0) > 0,
  };
}

/**
 * Merge custom authority bounds with defaults
 */
function mergeAuthority(
  defaultAuth: AuthorityBounds,
  custom?: Partial<AuthorityBounds>
): AuthorityBounds {
  if (!custom) return defaultAuth;

  return {
    max_authority_level: custom.max_authority_level ?? defaultAuth.max_authority_level,
    allowed_tools: custom.allowed_tools ?? defaultAuth.allowed_tools,
    denied_tools: custom.denied_tools ?? defaultAuth.denied_tools,
    max_token_budget: custom.max_token_budget ?? defaultAuth.max_token_budget,
    can_spawn_children: custom.can_spawn_children ?? defaultAuth.can_spawn_children,
  };
}

export class AgentInstance {
  public readonly agent: Agent;
  private messageHistory: LLMMessage[];

  constructor(
    role: RoleDefinition,
    opts?: {
      parent_id?: string;
      authority?: Partial<AuthorityBounds>;
      memory_scope?: string[];
    }
  ) {
    const defaultAuth = getDefaultAuthority(role);
    const authority = mergeAuthority(defaultAuth, opts?.authority);

    this.agent = {
      id: crypto.randomUUID(),
      role,
      parent_id: opts?.parent_id ?? null,
      status: 'active',
      session_id: crypto.randomUUID(),
      current_task: null,
      authority,
      memory_scope: opts?.memory_scope ?? [],
      created_at: Date.now(),
    };

    this.messageHistory = [];
  }

  get id(): string {
    return this.agent.id;
  }

  get status(): AgentStatus {
    return this.agent.status;
  }

  setTask(taskDescription: string): void {
    this.agent.current_task = taskDescription;
  }

  clearTask(): void {
    this.agent.current_task = null;
  }

  addMessage(role: 'user' | 'assistant' | 'system', content: string): void {
    this.messageHistory.push({ role, content });
  }

  getMessages(): LLMMessage[] {
    return [...this.messageHistory];
  }

  terminate(): void {
    this.agent.status = 'terminated';
    this.clearTask();
  }

  activate(): void {
    if (this.agent.status !== 'terminated') {
      this.agent.status = 'active';
    }
  }

  idle(): void {
    if (this.agent.status !== 'terminated') {
      this.agent.status = 'idle';
      this.clearTask();
    }
  }

  toJSON(): Agent {
    return { ...this.agent };
  }
}
