/**
 * Why a sub-agent run ended badly, in a form something other than a human can
 * read.
 *
 * The defect this exists for: `runSubAgent` catches everything and RESOLVES
 * with `{ success: false, terminationReason: 'error' }` rather than rejecting,
 * so the task manager's `.then()` branch used to stamp `completed` on a run
 * that had died three provider calls ago. A founder watching the agent strip
 * saw an emerald dot and a sentence beginning "Sub-agent error:", and the
 * daemon log said `Task <id> completed`. Both of those are lies and the second
 * one is the reason the fault survived three sessions of being looked for.
 *
 * Marking it `failed` is half the fix. The other half is that "failed" on its
 * own is not enough to say anything true to the person waiting: an agent that
 * could not be billed, an agent whose key is wrong and an agent whose tool
 * threw are three different facts, and only the third is about their work. So
 * every failure resolves to a KIND, and the kind carries the sentence the
 * founder is allowed to see.
 *
 * Deliberately much smaller than meeting mode's `done | staged | blocked`
 * contract on the `meeting-mode` branch. That one models a run that was
 * PARTLY successful and has something parked for approval. Nothing on this
 * path stages anything, so all this has to do is stop a dead run reporting as
 * a live one and say honestly which way it died.
 */

export type AgentFailureKind =
  /** The provider refused on money: no credit, quota exhausted, card declined. */
  | 'billing'
  /** Asked to slow down. Nothing is wrong; it was asked too fast. */
  | 'rate_limit'
  /** The key is missing, wrong, or not allowed to call what it called. */
  | 'auth'
  /** Could not reach the provider at all. */
  | 'network'
  /** The provider answered and the answer was its own failure. */
  | 'provider'
  /** It ran out of clock. */
  | 'timeout'
  /** Something inside the run threw: a tool, a parse, our own code. */
  | 'tooling'
  /** Classified nothing. Kept separate from `tooling` so the log is honest. */
  | 'unknown';

export type AgentFailure = {
  kind: AgentFailureKind;
  /** The raw message, kept whole for the log and for anyone debugging. */
  detail: string;
  /**
   * What a person is allowed to be told, in one sentence.
   *
   * Two rules hold across every one of these and they are the whole reason
   * this string lives next to the classifier rather than at each call site.
   *
   * 1. It says which side the fault is on. "Something went wrong" is the
   *    sentence that made this defect invisible.
   * 2. It never hands the reader a job. Not "check your billing", not "try
   *    again later". Where a retry is the right move, the retry is ours.
   */
  says: string;
};

/** Ordered most specific first: `insufficient_quota` is also a 429. */
const PATTERNS: { kind: AgentFailureKind; re: RegExp; says: string }[] = [
  {
    kind: 'billing',
    re: /credit_balance|insufficient[_ ]quota|exceeded your current quota|billing[_ ]hard[_ ]limit|payment[_ ]required|\b402\b|out of credit/i,
    says: 'The model provider turned the request away for billing, so it never got to run.',
  },
  {
    kind: 'auth',
    re: /invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication[_ ]error|permission[_ ]denied|\b401\b|\b403\b/i,
    says: 'The model provider rejected our credentials, so the request never reached a model.',
  },
  {
    kind: 'rate_limit',
    re: /rate[_ ]?limit|too many requests|\b429\b/i,
    says: 'The model provider asked us to slow down and the run was cut off part way.',
  },
  {
    kind: 'timeout',
    re: /timed? ?out|etimedout|deadline exceeded|aborted/i,
    says: 'The run ran past its clock before it had an answer.',
  },
  {
    kind: 'network',
    re: /econnrefused|enotfound|econnreset|network error|fetch failed|socket hang up|getaddrinfo/i,
    says: 'We could not reach the model provider at all.',
  },
  {
    kind: 'provider',
    re: /\b5\d\d\b|overloaded|server[_ ]error|service unavailable|bad gateway|upstream/i,
    says: 'The model provider failed on its own side while the run was in flight.',
  },
  {
    kind: 'tooling',
    re: /tool|registry|not a function|undefined is not|cannot read|json|parse|enoent|eacces/i,
    says: 'The run broke on something inside our own machinery rather than on the question.',
  },
];

/** Everything the runner prefixes onto an escaped exception, so the classifier
 *  sees the provider's own words rather than ours. */
const RUNNER_PREFIX = /^\s*(sub-agent error|task failed)\s*:\s*/i;

/**
 * Read a failure message and say which kind of failure it was.
 *
 * Never throws and never returns null: an unclassifiable failure is still a
 * failure and the caller has a founder waiting on it.
 */
export function classifyAgentFailure(raw: unknown): AgentFailure {
  const detail = messageOf(raw);
  const stripped = detail.replace(RUNNER_PREFIX, '');
  for (const p of PATTERNS) {
    if (p.re.test(stripped)) return { kind: p.kind, detail, says: p.says };
  }
  return {
    kind: 'unknown',
    detail,
    says: 'The run stopped before it had an answer, and the reason it gave does not name a cause.',
  };
}

function messageOf(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'message' in raw) {
    const m = (raw as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(raw);
}

/**
 * Is this a failure of ours rather than of the work?
 *
 * The distinction the trial needs. A billing refusal says nothing at all about
 * the founder's question, so the honest thing is to say so and keep the
 * question; a tool that threw halfway through at least got as far as their
 * material. Beat 14 reads this to decide whether it is reporting a finding it
 * could not get or a finding that does not exist.
 */
export function isInfrastructureFailure(kind: AgentFailureKind): boolean {
  return kind === 'billing' || kind === 'auth' || kind === 'rate_limit'
    || kind === 'network' || kind === 'provider' || kind === 'timeout';
}

/**
 * The one sentence a settled sub-agent gets to say for itself, wherever it
 * settled.
 *
 * A failure names its cause. "Could not complete its task" is equally true of
 * an agent that found nothing, an agent whose key is wrong and an agent nobody
 * paid for, and sending a person off to open a room to work out which is the
 * kind of small handing-back this product is not allowed to do.
 */
export function agentSettledNotice(task: {
  agentName: string;
  result?: { success?: boolean } | null;
  failure?: { says: string } | null;
}): string {
  if (task.failure) return `**${task.agentName} could not finish.** ${task.failure.says}`;
  const ok = task.result?.success ?? false;
  return ok
    ? `**${task.agentName} finished its task.** Open the Agents room to read the result.`
    : `**${task.agentName} could not finish.** The run stopped before it had an answer.`;
}
