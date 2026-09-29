/**
 * Turn tool scope: tools a particular KIND of turn does not have (#561).
 *
 * This is not the tool-relevance filter. That one chooses what is worth
 * OFFERING the model this turn and is explicitly recoverable: a tool it
 * withholds can be asked for with `discover_tools`, and an off-list call to
 * one is admitted and then dispatched (tool-relevance/discover.ts). A scope is
 * the other thing -- the tool is not part of this turn at all. It is filtered
 * out of the candidate set the filter sees, out of the catalogue
 * `discover_tools` answers from, and out of the registry lookup at dispatch,
 * so a model that calls it anyway is told the tool does not exist rather than
 * having the call run.
 *
 * ## The one scope the product has: a project-scoped site chat
 *
 * The chat on the Sites page sends `projectId`, and the daemon answers by
 * appending a prompt block that says (sites/prompt-context.ts):
 *
 *     - Use site_read_file, site_write_file, site_list_files, ... with
 *       project_id="...".
 *     - Do NOT use regular read_file, write_file, or run_command -- always
 *       use the site_* variants.
 *
 * Nothing enforced the second line. All four generic tools stayed registered
 * and, because ws-service sets the process-wide default cwd to the project for
 * the turn, all four resolved straight into it. Two things followed, both
 * measured in #529:
 *
 *  - The prompt's claim was not a contract. A model that ignored it read the
 *    same bytes through a tool that is neither framed as untrusted nor a taint
 *    source, and wrote the same files through one with no site gating.
 *  - The RELEVANCE FILTER PREFERRED THE GENERIC ONE. On "install react-router
 *    in the project" it offered `run_command` and withheld
 *    `site_run_command`, because that sentence has install/build words but
 *    nothing that reads as site BUILD intent. So #529's framing was bypassed
 *    by the filter's own selection on an ordinary site ask, with no model
 *    misbehaviour involved at all.
 *
 * The scope makes the prompt's line true. It is also why the sentence can stay
 * in the prompt: the model is told the same thing the registry now enforces.
 *
 * ## What is withheld, and what is deliberately not
 *
 * WITHHELD: the four generic local file and shell tools the prompt names, plus
 * the two delegation tools. Delegation is not a separate capability here --
 * `delegate_task` and `manage_agents` build a sub-agent registry by CATEGORY
 * (`createScopedToolRegistry`, agents/sub-agent-runner.ts), the shipped
 * software-engineer role asks for `terminal` and `file-ops`, and the sub-agent
 * runs inside this turn with the same default cwd. Leaving them in would keep
 * exactly the route the scope exists to close, one hop further away.
 *
 * NOT withheld: everything else. The scope is deliberately not "the eight
 * site-builder tools and nothing else", because the Sites page composer is a
 * general chat box that happens to carry a project id -- "remind me to deploy
 * this tomorrow" and "put this in a note" are ordinary things to type into it,
 * and pinning the turn to the site set would answer them with a shrug. The
 * contract being enforced is the prompt's, which is about the file and shell
 * tools, not about the rest of the assistant.
 *
 * ## The legitimate use this does cost, and why it is acceptable
 *
 * One: reading a file from OUTSIDE the project to bring its content in ("use
 * the text from ~/docs/cv.md on the about page"). No site tool can do that --
 * they are confined to the project by ProjectManager.safeJoin -- so only the
 * generic `read_file` serves it, and in a project-scoped chat it no longer
 * exists. The capability is not removed from the product: the site tools are
 * registered globally, so the same ask works in the main chat, which has both
 * halves. Weighed against a read that is unframed, non-tainting and resolves
 * with no containment (actions/tools/file-path-policy.ts), in the one chat
 * whose content is most likely to have come from a pulled repo, the trade is
 * the right way round -- and it is the trade #561 asks for: containment where
 * a generic tool is genuinely needed, removal where it is not.
 *
 * ## What this does NOT close
 *
 * Three routes #570 recorded. The first is closed as of #571; the other two are
 * still open deliberately, and none of the three was ever silent. Each entry
 * keeps its original text so the reasoning that was acted on stays readable
 * next to what was done about it.
 *
 * 1. ~~**The router-first conv path.**~~ CLOSED by #571. The scope and the
 *    site prompt block now travel `ws-service` -> `AgentService.streamMessage`
 *    -> `streamMessageConv` -> `ConvOrchestrator.streamTurn` (as the required
 *    `ConvTurn` argument) -> `TaskDispatcher.dispatch`/`resume` -> the task
 *    runner -> `AgentOrchestrator.processTaskCall`, where all three checks
 *    attach exactly as they do on the classic loop.
 *
 *    Worth keeping from the original note, because it is the reason dispatch
 *    is the load-bearing check rather than one of three equals: on a REAL
 *    hosted install the relevance filter never engages at all. Every empty
 *    tier slot is filled with `usejarvis_ai:uj-*` (daemon/usejarvis-ai.ts) and
 *    `usejarvis` is in `FRONTIER_VETO` (tool-relevance/model-class.ts), so
 *    `decideTools` returns everything it was handed. Measured on the
 *    production registry: 50 tools unscoped, 44 scoped, filter disengaged. The
 *    candidate set still narrows, because `toolsInScope` is applied before
 *    every early return, but the pin and the substitution never run, and
 *    nothing except the dispatch check can refuse a call.
 *
 *    Three things #571 fixed alongside it, each a way the per-turn scope was
 *    undone by a process-global data path: `noteToolUse`/`seedFromMessages`
 *    wrote a refused tool into the shared primary ledger (see
 *    `outOfScopeMessage`); `ConvOrchestrator` kept the turn's user message in
 *    a mutable field two concurrent chats raced over; and the paused-task
 *    buffer persisted its system messages, so a site prompt block with
 *    repo-written file names in it outlived the turn, the conversation and the
 *    daemon process.
 *
 *    Still open, and the shape every remaining item shares: the scope draws a
 *    TOOL boundary where no CONTEXT boundary exists. The Sites composer sends
 *    no `channel`, so it shares the conversation row, the primary agent's
 *    history, the primary exposure ledger and the global TaskRegistry with the
 *    main dashboard chat -- and with every OTHER project's chat. #571 closed
 *    the ledger, and it closed the task registry by giving each record the
 *    chat that created it (`TaskRecord.contextKey`, which carries the project
 *    id, not just this scope's id -- there is one scope object for every site
 *    chat, so comparing scopes would have made two projects' chats the same
 *    context). `check_task`, `cancel_task`, `resume` and the router prompt's
 *    task list all match on it. The shared conversation row and the primary
 *    agent's history are untouched, so what a site task's VERBALIZED answer
 *    carries into the other chats' dialogue window is still open.
 *
 * 2. **`commitments`.** It stays in scope, and it is the one in-scope tool
 *    whose whole effect is to schedule a LATER turn whose entire text the
 *    model writes -- `authority-classes.ts` already singles it out for exactly
 *    that. The scope is per-turn, so the executor's turn does not carry it.
 *
 *    #571 did the FIRST of the two things this needs and deliberately not the
 *    second. The originating scope is now recorded on `commitments.scope_id`,
 *    for both routes that matter: ws-service stamps it explicitly on the
 *    auto-created tracked task, and `createCommitment` otherwise defaults it
 *    from the ambient turn scope (`turn-scope-store.ts`, entered per tool call
 *    in `executeTool`), which is what covers the row the MODEL writes through
 *    the `commitments` tool inside a scoped chat -- the route this note is
 *    actually about. So the fact is durable and auditable instead of lost at
 *    creation.
 *
 *    The executor still does not RUN under it, because measuring what that
 *    would do says it is worse than the gap. A due commitment executes through
 *    `BackgroundAgentService`, which owns a SEPARATE AgentOrchestrator and a
 *    separate tool registry, and the site-builder tools are registered only
 *    into the main orchestrator's registry (daemon/index.ts). Applying this
 *    scope there withholds the four generic file and shell tools while the
 *    pinned `site-builder` category is empty, so the substitution rule below
 *    has nothing to substitute and "deploy the site tonight" gets no file tool
 *    at all -- the exact starvation that rule exists to prevent, reintroduced
 *    by enforcing the scope in the one place its replacement surface is
 *    absent. Closing it means either registering the site tools on the
 *    background registry (a behaviour expansion: they become reachable from
 *    every background turn, under a different authority profile, and #570
 *    rates a site build-file write as execution) or routing a scoped
 *    commitment through the main orchestrator. Either is its own change.
 *
 *    The control meanwhile is PARTIAL, and commitment-executor.ts spells out
 *    why: the background profile governs `execute_command` and `write_data`
 *    but NOT `read_data`, and an explicit `governed_categories: []` opts out of
 *    it altogether. So the unframed generic READ on a later turn -- consequence
 *    one of #561 -- is ungated there. A loud log line makes a scoped commitment
 *    running unscoped visible rather than silent; it is not a fix. The taint
 *    profile is the other half (`commitments` is `write_data`, governed on a
 *    tainted turn), with the per-turn hole the #529 note describes: content
 *    read on the previous turn acts on a clean one.
 *
 * 3. **`manage_workflow`.** It can compose and run a flow whose step names
 *    `run_command` or `write_file`, and the effect boundary dispatches through
 *    `registry.execute` (workflows/runtime/service-backends.ts), not through
 *    the orchestrator's dispatch check. An earlier version of this note argued
 *    it was "not a file tool the filter would hand over on a site ask";
 *    measurement says otherwise -- on "automate the deploy for this project"
 *    the scoped decision keeps all 44 candidates, `manage_workflow` among
 *    them. It is still not withheld: `run` is raised to `execute_command` with
 *    a card, code steps go through `assertCodeStepsAllowed`, and withholding
 *    it would answer an automation ask with a sentence about site tools. The
 *    honest fix is the one the boundary is already shaped for -- carry the
 *    composing turn's scope onto the flow record and refuse a step naming a
 *    tool that turn did not have.
 *
 *    CORRECTION (#571 review): that remediation is too narrow, and
 *    implementing it would leave the route open while looking closed. A flow
 *    can carry an AGENT step, and `workflows/adapters/m7-agent-delegator.ts`
 *    delegates to `runSubAgent` with a category-scoped registry built from
 *    `terminal` + `file-ops`; the effect boundary then executes
 *    `call.toolCall.name`, chosen at RUN time by that sub-agent
 *    (workflows/runtime/service-backends.ts). Such a step names no tool
 *    statically, so "refuse a step naming a tool that turn did not have"
 *    never fires for it. The scope has to reach the runtime registry itself --
 *    `toolsInScope` applied to the registry the delegator builds -- not just
 *    the flow record. #573 owns those files.
 *
 * 4. **The realtime voice tool surface.** `executeRealtimeToolCall`
 *    (agents/orchestrator.ts) is a FOURTH dispatch route: it calls
 *    `toolRegistry.execute` directly, consults no scope, enters no turn-scope
 *    store, and uses none of `decideTurnTools` / `executeTool` /
 *    `noteToolUse` / the interceptors -- so none of the drift guards in
 *    tool-scope.test.ts can see it, and `path-parity-scope.test.ts`'s "all
 *    three tool loops" is exhaustive only over the loops that take an LLM
 *    turn. It is unreachable from a site chat today: a realtime session has
 *    no `projectId`, and the voice fall-through into `handleChat` builds a
 *    payload without one (pinned by a guard in tool-scope.test.ts). Listed
 *    here so the day voice gains a project context the scope is known to have
 *    to ride along, rather than the parity test reading as a proof it already
 *    does.
 *
 * Also unfixed, and older than this change: the default cwd is a process-wide
 * global shared by every concurrent chat (actions/tools/local-tools-guard.ts).
 * Nothing in production sets it any more, which is why it is quiet rather than
 * fixed.
 */

import type { ToolDefinition } from './registry.ts';
import { NOT_RUN_MARKER } from './tool-relevance/ledger.ts';

export type TurnToolScope = {
  /**
   * Stable identifier for this scope (#571).
   *
   * Used to record WHICH POLICY a turn ran under on something outliving the
   * turn -- today only `commitments.scope_id`, which the commitment executor
   * reads to log that a scoped chat scheduled the work it is about to run
   * unscoped. It is never resolved back into a policy object and never read
   * from model output.
   *
   * Not what identifies a CHAT: there is one scope object for every
   * project-scoped chat, so matching a paused task to the chat that created it
   * uses a separate key that carries the project (TaskRecord.contextKey).
   */
  readonly id: string;
  /** Short phrase for the refusal the model sees, e.g. "a site project chat". */
  readonly label: string;
  /** Tool names this kind of turn does not have. */
  readonly withheld: ReadonlySet<string>;
  /**
   * Tool categories that STAND IN for what this scope withheld.
   *
   * Withholding without them made the turn worse, which is why they exist.
   * The filter selects on the user's words, and the site group is triggered
   * by build intent only ("landing page", "static site"): on "install
   * react-router in the project" it was offering the generic `run_command`
   * and withholding `site_run_command`. Take the generic tools away and that
   * ask matches nothing at all, so the chat that exists to work on a project
   * is handed no file tool of any kind -- measured, not assumed.
   *
   * They are NOT simply always on, which is what the first version did and
   * what a security review measured as the wrong trade: six of the eight site
   * tools are invariant triggers, so I1's union repair fired every turn and
   * force-added every framed perception tool in the registry. "Put this in a
   * note" went from 4 offered tools to 27 -- including `browser_evaluate`,
   * which carries the same authority rank as `run_command`, plus `ui_act`,
   * the desktop actuators and the clipboard. Reaching any of those used to
   * take a `discover_tools` admission or an off-list call, and BOTH leave an
   * audit row; simply offering them leaves none. A scope that quietly widens
   * the menu on the highest-injection-risk chat is not a containment.
   *
   * So the rule is substitution (`decideTools`): the surface comes in when the
   * ask reached for a tool this scope withheld, or when it matched no trigger
   * group at all -- in a chat bound to one project, an unclassifiable ask is
   * most plausibly about that project. Its framed READERS are always in, being
   * read_data, path-confined, framed and no invariant trigger. Measured after
   * the change: "put this in a note" 6 tools, "set a goal to ship by friday" 6,
   * "install react-router in the project" 26 with all eight site tools and no
   * generic one.
   *
   * What that leaves: an ask which matches some UNRELATED group and reaches
   * for nothing withheld gets the readers but not the actors -- "commit and
   * push the site to github" matches the commitments group on the word
   * "commit". The model can still see the project, and `discover_tools` will
   * hand it the rest, which is the escape hatch working and leaves the audit
   * row that simply offering them would not.
   *
   * Pinning happens at the filter's candidate step, not after it, so these
   * tools still go through `normalizeToolSet` and cannot be a way to smuggle
   * an unframed actor past the framing invariant.
   */
  readonly pinnedCategories: readonly string[];
};

/**
 * The scope for a chat bound to one site-builder project (a `chat` frame
 * carrying `projectId`; daemon/ws-service.ts).
 */
export const PROJECT_SITE_CHAT_SCOPE: TurnToolScope = Object.freeze({
  id: 'project_site_chat',
  label: 'a site project chat',
  withheld: Object.freeze(new Set([
    // The four the prompt already forbids, each with a site_* equivalent
    // that is path-confined, framed and gated.
    'read_file',
    'write_file',
    'list_directory',
    'run_command',
    // A sub-agent built from `terminal` + `file-ops`, running in this turn
    // with this cwd, is those same four tools with an extra hop.
    'delegate_task',
    'manage_agents',
  ])),
  // The whole site-builder category, by category rather than by name so a
  // ninth site tool is pinned the day it is registered.
  pinnedCategories: Object.freeze(['site-builder']),
});

/**
 * Every scope this build defines.
 *
 * A closed list, so a test can quantify over all of them (the
 * `request_approval` invariant in tool-scope.test.ts) rather than over the one
 * that happened to be remembered.
 *
 * There is deliberately NO id -> scope lookup, and nothing resolves a stored
 * id back into a policy. An earlier draft of #571 had one, together with a
 * `mergeScopes` that unioned a stored scope with the live turn's; both went
 * when `TaskDispatcher.resume` moved to match-or-refuse, and leaving them as
 * unused exports with a doc block describing a fail-closed mechanism no call
 * site performed would have been the exact defect this change exists to remove
 * -- something threaded and then never consulted, in the file that is the
 * design record. The scope a turn RUNS under always comes from that turn;
 * stored keys are only ever compared for equality (see TaskRecord.contextKey).
 */
export const ALL_SCOPES: readonly TurnToolScope[] = Object.freeze([PROJECT_SITE_CHAT_SCOPE]);

/** Whether a turn under `scope` has the named tool at all. */
export function toolInScope(scope: TurnToolScope | null | undefined, name: string): boolean {
  if (!scope) return true;
  try {
    return !scope.withheld.has(name);
  } catch {
    // Fails OPEN, on purpose, and it is worth being exact about why rather
    // than claiming otherwise: the alternative is a scope whose `withheld`
    // cannot be read making EVERY tool vanish mid-turn, including the site
    // tools the chat exists for. There is no input that reaches this -- the
    // only scope in the product is a frozen module constant, and
    // tool-scope.test.ts pins that -- so this branch is a latent-defect guard,
    // not a policy. The policy is that a scope must be constructed correctly;
    // if scopes ever become configurable, they need validating where they are
    // built, not here.
    return true;
  }
}

/**
 * Whether this tool belongs to the surface that stands in for what `scope`
 * withheld. Whether it is actually offered is decided in `decideTools`, which
 * is the only place that can see the turn's text.
 */
export function isScopePinned(tool: Pick<ToolDefinition, 'category'>, scope: TurnToolScope | null | undefined): boolean {
  if (!scope) return false;
  try {
    return scope.pinnedCategories.includes(tool.category);
  } catch {
    // A malformed scope loses its pins, never its withholding: the failure
    // direction is a smaller tool list, not a wider one.
    return false;
  }
}

/**
 * The candidate tools for a turn under `scope`. Applied to the registry
 * listing BEFORE the relevance filter and before the discovery catalogue, so
 * neither can offer, reveal or admit what the turn does not have.
 */
export function toolsInScope(
  all: readonly ToolDefinition[],
  scope: TurnToolScope | null | undefined,
): readonly ToolDefinition[] {
  if (!scope || scope.withheld.size === 0) return all;
  return all.filter((tool) => toolInScope(scope, tool.name));
}

/**
 * The prompt block that tells the model, up front, what this turn does not
 * have -- the other half of the `[NOT RUN]` refusal below (#571).
 *
 * The gap it closes: the cached tool guide in the system prompt
 * (roles/tool-guide.ts, rendered by roles/prompt-builder.ts) documents every
 * registered tool, including the withheld ones, and it says to use them.
 * Without a correction the model is being instructed to call a tool that will
 * be refused, and each attempt is a full billed turn plus an
 * `out_of_scope(...)` audit row for something the prompt asked for.
 *
 * Why here and not in the guide itself: the guide sits in the STATIC half of
 * the prompt, which is the provider's cache prefix. Varying it per chat would
 * miss the cache on every turn of every hosted install, to save a few dozen
 * tokens. This block goes in the DYNAMIC half instead, where per-turn text
 * already lives, so the prefix is untouched.
 *
 * It states absence, like the refusal, rather than prohibition: "you do not
 * have" and not "you must not", because the former is simply true and the
 * latter is the kind of rule a model talks itself past.
 */
export function scopeSystemNote(scope: TurnToolScope): string {
  const names = [...scope.withheld].sort().map((n) => `\`${n}\``).join(', ');
  return [
    '# Tools this chat does not have',
    '',
    `This is ${scope.label}. The tool guide above documents the whole registry, `
    + 'but the following tools are not registered for this conversation and calling '
    + `them does nothing: ${names}.`,
    '',
    'Use the `site_*` tools with the project\'s `project_id` for anything in the '
    + 'project. They are path-confined to it, which the generic ones are not. '
    + 'Everything else you have is unchanged.',
  ].join('\n');
}

/**
 * What the model is told when it calls a tool this turn does not have.
 *
 * Phrased as absence, not as denial: this is not an authority decision, and
 * "[AUTHORITY DENIED]" would read as "ask the user to approve it" and invite a
 * retry. Naming the replacement is the point -- the model called the generic
 * tool because it wanted the project's files, and the site tools are right
 * there.
 *
 * Two deliberate details. It says the tool will not become available. The
 * cached tool guide in the system prompt still documents every registered
 * tool and will keep suggesting it; `scopeSystemNote` above now corrects that
 * up front, but this sentence is the backstop for a turn that reached here
 * anyway, and without it the model has a standing invitation to retry -- each
 * retry a full billed turn.
 *
 * And it opens with NOT_RUN_MARKER, so a refusal reads as a refusal rather
 * than as output the tool produced.
 *
 * An earlier version of this note claimed the marker also keeps the name out
 * of the shared exposure ledger on a resume, because "a durable buffer that
 * seeds a resumed turn from stored tool results skips calls marked that way".
 * That was wrong in two ways and is worth recording rather than quietly
 * deleting. `ledger.seedFromMessages` skips `SKIPPED_PREFIX` ('[Not run:'),
 * which is a DIFFERENT string from NOT_RUN_MARKER ('[NOT RUN]'), and it
 * deliberately DOES seed a marked off-list refusal -- correctly, because for
 * an off-list call the live loop admitted and audited that name. An
 * out-of-scope refusal is the opposite of an admission, so the marker was
 * never going to be the control here.
 *
 * What is, since #571: `noteToolUse` and `seedFromMessages` are both gated on
 * `toolInScope` (agents/orchestrator.ts). That matters because the ledger is
 * the PRIMARY agent's, one set for the whole process shared by every chat, and
 * `decideTools` keeps anything in it unconditionally -- so without the gate a
 * site chat's refused `run_command` force-offered the shell in the next
 * non-site turn, permanently and with no audit row anywhere.
 */
export function outOfScopeMessage(scope: TurnToolScope, name: string): string {
  return `${NOT_RUN_MARKER} Error: no tool named "${name}" is available in ${scope.label}, `
    + 'and it will not become available in this chat. This call was not executed. '
    + 'Use the site_* tools with the project_id for anything in the project.';
}
