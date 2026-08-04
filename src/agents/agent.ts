import type { RoleDefinition } from '../roles/types.ts';
import type { LLMMessage } from '../llm/provider.ts';
import { compactHistory, measureMessage } from '../llm/history.ts';

/**
 * In-memory retention budget for an agent's message history, in estimated
 * tokens. Matches the largest request-time compaction budget (Anthropic,
 * 200k context) so this bound never drops context a provider could still
 * send — request-time compactHistory stays the binding constraint for what
 * goes on the wire; this one only stops the daemon-lifetime array from
 * growing without limit.
 */
const HISTORY_RETENTION_TOKENS = 200_000;

/**
 * Compaction only runs once the running estimate exceeds this multiple of
 * the budget, and trims back to the budget. Amortizes the O(history)
 * compaction pass instead of paying it on every append.
 */
const HISTORY_COMPACT_TRIGGER = 1.1;

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
 * Whether a role is allowed to spawn sub-agents.
 *
 * A role can delegate when it declares the `delegation` tool (the
 * mechanism `delegate_task` / `manage_agents` actually use — specialists
 * are discovered from roles/specialists/, not from the role file) OR
 * when it defines legacy `sub_roles` templates. Deriving this from
 * `sub_roles` alone broke delegation for the default personal-assistant
 * role: it ships the delegation tool and a prompt that advertises
 * delegation, but no `sub_roles`, so every spawn was refused regardless
 * of the configured authority level.
 */
export function canSpawnChildren(role: RoleDefinition): boolean {
  return role.tools.includes('delegation') || (role.sub_roles?.length ?? 0) > 0;
}

/**
 * Default authority bounds for an agent
 */
function getDefaultAuthority(role: RoleDefinition): AuthorityBounds {
  return {
    max_authority_level: role.authority_level,
    allowed_tools: role.tools,
    denied_tools: [],
    max_token_budget: 100000,
    can_spawn_children: canSpawnChildren(role),
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
  /** Running measureMessage total; recomputed after each compaction. */
  private historyTokenEstimate = 0;

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

  addMessage(role: 'user' | 'assistant' | 'system', content: string | import('../llm/provider.ts').ContentBlock[]): void {
    if (role === 'assistant') {
      // An assistant message closes the turn: any image the LLM needed this
      // turn has been sent, so stop pinning its base64 payload (up to 5MB
      // each) in the heap. Entries are replaced, not mutated — an in-flight
      // request may still hold a reference to the original message object.
      this.releaseImagePayloads();
    }
    const message: LLMMessage = { role, content };
    this.messageHistory.push(message);
    this.historyTokenEstimate += measureMessage(message);
    if (this.historyTokenEstimate > HISTORY_RETENTION_TOKENS * HISTORY_COMPACT_TRIGGER) {
      this.messageHistory = compactHistory(this.messageHistory, HISTORY_RETENTION_TOKENS);
      this.historyTokenEstimate = this.messageHistory.reduce((sum, m) => sum + measureMessage(m), 0);
    }
  }

  private releaseImagePayloads(): void {
    for (let i = 0; i < this.messageHistory.length; i++) {
      const entry = this.messageHistory[i]!;
      if (typeof entry.content === 'string') continue;
      if (!entry.content.some((b) => b.type === 'image')) continue;
      this.messageHistory[i] = {
        ...entry,
        content: entry.content.map((b) =>
          b.type === 'image'
            ? { type: 'text' as const, text: '[screenshot from an earlier turn — no longer available]' }
            : b
        ),
      };
    }
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
