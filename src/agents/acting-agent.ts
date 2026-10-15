/**
 * The sub-agent whose tool call is running, as ambient context for the agent
 * lifecycle sinks (#1014).
 *
 * `delegate_task` and `manage_agents` start a specialist under the primary:
 * their `execute(params)` is handed the model's arguments and nothing about
 * who made the call. That was right while only the primary's loop could reach
 * them. A sub-agent whose registry holds them (a workflow-delegated agent's
 * `scopedRegistry`, any registry built with the delegation category) then
 * started the specialist as the PRIMARY's child: the primary's level and
 * tools, the primary's profile, judged at the sink as the primary. Its own
 * level, tools and taint were dropped, so a lower or tainted sub-agent could
 * start something stronger than itself, and delegating laundered its taint.
 *
 * So `runSubAgent` runs every tool dispatch inside this scope, naming the
 * sub-agent and the restrictions it is under at that moment, and the sinks
 * (`orchestrator.spawnSubAgent`, `terminateAgent`) read it: the act is judged
 * as that agent, a spawned child is capped by its level and tools, and the
 * child runs under its restrictions and taint for every run it ever makes.
 *
 * WHY AMBIENT, for the reason `approved-action-scope.ts` gives: an argument
 * naming the caller would be one the model can write. Only `runSubAgent`
 * enters it, for its own agent. Absent means nobody but the primary or the
 * person (a model turn, the dashboard, voice, an approved card) is acting.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthorityProfile } from '../authority/engine.ts';

export type ActingAgent = {
  readonly agentId: string;
  /** What its run is restricted by at the time of the call: its parent's profile and, where its run gates taint, its taint. */
  readonly profile: AuthorityProfile | null;
  /** The outside content its run has read, whether or not that run gates on it. */
  readonly taint: readonly string[];
};

/** An acting agent as the sinks read it: `settled` once the call that named it has returned. */
export type ActingCall = ActingAgent & { readonly settled: boolean };

const store = new AsyncLocalStorage<ActingCall>();

/**
 * Run `fn` as a tool call `agent` made. The scope names the agent for that
 * call only: a timer or a continuation the call left behind still sees the
 * store, so it is marked settled when the call returns, and a sink reached
 * from it then refuses rather than act for an agent whose call is over --
 * the rule `runAsApproved` applies to an approval. Never "nobody acting",
 * which would judge the act as the primary.
 */
export function runAsActingAgent<T>(agent: ActingAgent, fn: () => T): T {
  const live = { ...agent, settled: false };
  const close = () => { live.settled = true; };
  let result: T;
  try {
    result = store.run(live, fn);
  } catch (err) {
    close();
    throw err;
  }
  if (result instanceof Promise) return result.finally(close) as T;
  close();
  return result;
}

/** The sub-agent whose call is running (or ran), or null when none is. */
export function actingAgent(): ActingCall | null {
  return store.getStore() ?? null;
}

/**
 * Run `fn` outside any acting agent. For work that outlives the call that
 * started it -- a background task loop -- which names its own agent on each
 * dispatch.
 */
export function outsideActingAgent<T>(fn: () => T): T {
  return store.exit(fn);
}
