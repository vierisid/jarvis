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
 * Three routes, all found by review, all left open deliberately and none of
 * them silent:
 *
 * 1. **The router-first conv path.** When a conversation tier is configured --
 *    which is every hosted install, since the tier defaults are filled per
 *    slot -- `AgentService.streamMessage` takes the conv branch, which drops
 *    `siteContext` AND never reaches the orchestrator loop this scope threads
 *    through. Such a turn keeps the generic tools and loses the prompt line
 *    that used to be their only restraint, so it is the pre-#561 state exactly.
 *    What this change does about it is remove the amplifier: ws-service no
 *    longer points the process-wide default cwd at the project, so those tools
 *    resolve in the home dir rather than inside the tree a pulled repo sits in.
 *    Threading the scope and the site prompt through ConvOrchestrator and the
 *    task dispatcher is the real repair, and it is a separate change.
 *
 * 2. **`commitments`.** It stays in scope, and it is the one in-scope tool
 *    whose whole effect is to schedule a LATER turn whose entire text the
 *    model writes -- `authority-classes.ts` already singles it out for exactly
 *    that. The scope is per-turn, so the executor's turn does not carry it.
 *    Closing it properly means recording the originating scope on the
 *    commitment row and running the executor under it. Until then the taint
 *    profile is the control (`commitments` is `write_data`, which is governed
 *    on a tainted turn), and that control has the per-turn hole the #529 note
 *    describes: content read on the previous turn acts on a clean one.
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
 * Also unfixed, and older than this change: the default cwd is a process-wide
 * global shared by every concurrent chat (actions/tools/local-tools-guard.ts).
 * Nothing in production sets it any more, which is why it is quiet rather than
 * fixed.
 */

import type { ToolDefinition } from './registry.ts';
import { NOT_RUN_MARKER } from './tool-relevance/ledger.ts';

export type TurnToolScope = {
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
 * What the model is told when it calls a tool this turn does not have.
 *
 * Phrased as absence, not as denial: this is not an authority decision, and
 * "[AUTHORITY DENIED]" would read as "ask the user to approve it" and invite a
 * retry. Naming the replacement is the point -- the model called the generic
 * tool because it wanted the project's files, and the site tools are right
 * there.
 *
 * Two deliberate details. It says the tool will not become available, because
 * the cached tool guide in the system prompt still documents every registered
 * tool and will keep suggesting it: without that sentence the model has a
 * standing invitation to retry, and each retry is a full billed turn.
 *
 * And it opens with NOT_RUN_MARKER, the same marker the off-list refusal uses.
 * A durable buffer that seeds a resumed turn from stored tool results skips
 * calls marked that way; a refusal that is not marked would come back as
 * though the tool had produced that string, seeding the withheld name into
 * the shared exposure ledger. The streaming chat loop persists nothing today,
 * so this is the latent half of the conv-path unification below.
 */
export function outOfScopeMessage(scope: TurnToolScope, name: string): string {
  return `${NOT_RUN_MARKER} Error: no tool named "${name}" is available in ${scope.label}, `
    + 'and it will not become available in this chat. This call was not executed. '
    + 'Use the site_* tools with the project_id for anything in the project.';
}
