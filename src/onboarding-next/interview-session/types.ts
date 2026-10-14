import type { InterviewSession, InterviewTurnResult } from '../../daemon/onboarding-interviewer.ts';
import type { appendUserProfileFact } from '../../vault/user-profile.ts';

export type Scope = { actorId: string; projectId: string };
export type Phase = 'connecting' | 'ready' | 'thinking' | 'error' | 'done' | 'skipped';
export type Fact = Parameters<typeof appendUserProfileFact>[0];
export interface Answer {
  sessionId: string;
  turnId: string;
  clientRequestId: string;
  text: string;
}
export type Command = { type: 'start' } | { type: 'read'; sessionId: string }
  | ({ type: 'answer' } & Answer)
  | { type: 'retry'; sessionId: string }
  /** Null means the authenticated current session before opening acknowledgement. */
  | { type: 'skip'; sessionId: string | null };
export interface Message { id: string; role: 'user' | 'assistant'; text: string; clientRequestId?: string }
export interface Snapshot {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  cursor: number;
  phase: Phase;
  messages: Message[];
  confirmedFactIds: string[];
  pendingAnswer: Answer | null;
  farewell?: string;
  error?: 'turn_failed' | 'turn_timeout' | 'save_failed' | 'save_timeout';
}
export type Result = { kind: 'ok'; snapshot: Snapshot }
  | { kind: 'unavailable' | 'invalid' | 'conflict' | 'unauthorized'; reason: string };
export interface PreparedTurn {
  session: InterviewSession;
  result: InterviewTurnResult;
  facts: Fact[];
}
/** The existing interviewer must be injected through an effect-staging adapter.
 * prepare may call the model but MUST NOT write facts, mark completion, or emit
 * events. ON-B-05 supplies that binding; legacy runInterviewTurn writes inline
 * and is deliberately NOT a compatible default. No prompt/engine is copied here. */
export interface InterviewerPort {
  create(): InterviewSession;
  prepare(input: { scope: Scope; session: InterviewSession; answer: string | null;
    turnId: string; signal: AbortSignal }): Promise<PreparedTurn>;
}
export interface CommitInput {
  scope: Scope;
  sessionId: string;
  turnId: string;
  clientRequestId: string;
  /** Stable through errors, process restarts and retries. Never a lease ID. */
  attemptId: string;
  facts: Fact[];
  wrap: boolean;
  signal: AbortSignal;
  /** Recheck before each effect; false after skip, lease loss or auth loss. */
  isCurrent(): boolean;
}
/** ON-B-05 owns idempotent profile writes and reconciliation by attemptId.
 * A repeated commit must reconcile its durable receipt, never repeat an effect.
 * Resolve only after required writes (and wrap, when requested) are confirmed. */
export interface ProfilePort {
  capability: 'interview-profile.v1';
  commit(input: CommitInput): Promise<{ confirmedFactIds: string[] }>;
}
export interface PendingTurn {
  turnId: string;
  clientRequestId: string;
  text: string | null;
  attemptId: string;
  prepared?: PreparedTurn;
  lease?: { id: string; expiresAt: number };
}
export interface RecordV1 {
  schemaVersion: 1;
  scopeKey: string;
  snapshot: Snapshot;
  /** System prompt is supplied by the existing interviewer, not duplicated. */
  checkpoint: Omit<InterviewSession, 'messages'> & { messages: InterviewSession['messages'] };
  pending: PendingTurn | null;
  receipts: { clientRequestId: string; turnId: string; text: string | null }[];
}
export interface Store {
  transaction<T>(scope: Scope, operation: (tx: {
    current: unknown;
    write(record: RecordV1): void;
  }) => T): T;
}
export interface Dependencies<Context> {
  enabled?: boolean;
  /** Authenticated server context only. Resolve again after awaited work. */
  authorize(context: Context): Scope | null;
  store: Store;
  interviewer?: InterviewerPort;
  profile?: ProfilePort;
  now?: () => number;
  timeoutMs?: number;
}
