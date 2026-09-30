/**
 * Adapter: PieceToolRegistry over Jarvis' ToolRegistry. The signatures align
 * almost 1:1; this file projects field names and unwraps the description for
 * the listing API.
 */

import type {
  PieceToolDescription,
  PieceToolRegistry,
} from "../jarvis-pieces/types";
import type { ToolRegistry } from "../../actions/tools/registry";
import { dropTrustedTrailer } from "../../roles/untrusted.ts";
import { withoutTemplateDelivery } from "../../actions/tools/template-delivery-scope.ts";

export class JarvisToolRegistryAdapter implements PieceToolRegistry {
  constructor(private readonly registry: ToolRegistry) {}

  has(name: string): boolean {
    return this.registry.has(name);
  }

  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    // A carrier is unwrapped to its payload; EVERYTHING ELSE passes through
    // untouched. In particular the result is NOT FRAMED as untrusted content,
    // for any tool, and that is a decision (#573) -- not the oversight the
    // absence used to read as.
    //
    // WHY NOT FRAMED. Frame at the boundary where content enters a MODEL's
    // context, not at the boundary where it leaves a tool. In a chat turn those
    // are the same object, which is why `markUntrustedToolResult` sits on the
    // tool and why reasoning by analogy from chat feels right. Here they come
    // apart: a step's result goes into the flow graph as DATA, read by `{{ }}`
    // expressions and by other steps, and it reaches a model only somewhere
    // else. goals/rhythm.ts already frames workflow-derived content that way --
    // at the prompt, not at the tool (see its note on `blocker.reason`).
    //
    // Eight tools a step can name ARE untrusted sources: read_file,
    // get_clipboard, browser_snapshot, browser_screenshot, desktop_snapshot,
    // desktop_find_element, desktop_list_windows, run_skill. Framing them here
    // would not be a cost paid for safety, it would be silent corruption:
    // `read_file` -> `write_file` in a flow would write the preamble and
    // delimiters INTO the file, deterministically, every run, unattended. The
    // chat path accepts a weaker form of that hazard (see `wrapUntrusted`) only
    // because a model re-renders the content and a person is watching.
    //
    // And the author could not repair it. `{{ }}` is a data interpreter with no
    // method calls -- runtime/safe-expression.ts fails any call expression with
    // "function calls or other executable syntax" -- so there is no supported
    // way to strip a preamble from a string. The only escape is a CODE step,
    // which runs arbitrary JavaScript with this machine's privileges and is off
    // by default. Framing would push flow authors to enable code execution in
    // order to clean up a mitigation, which is a worse trade than the one it
    // buys: there is no taint gate on this path, and the approval card that does
    // exist reviews frozen ARGUMENTS before dispatch, so it never sees a result.
    //
    // The receipt widens the blast radius rather than containing it: this value
    // is also merged into `flow_version.sample_data` after a successful run
    // (runner/handler.ts) and replayed as step INPUT for test-from-here runs, so
    // a frame here would corrupt future runs' inputs too.
    //
    // The model boundaries are what this defers to, and they have to be
    // enumerated rather than assumed away. Keeping that list complete is what
    // makes this decision safe rather than merely convenient, which is why
    // untrusted-reach.test.ts pins the READERS as well as the reachable tools.
    //
    //   - CLOSED by #582: a `manage_workflow` run listing used to hand captured
    //     step output to the chat model unframed (get_run's `steps`, list_runs'
    //     `failedStep`, and `get` via `sample_data`). All three now return one
    //     framed block wrapping the action's JSON, capped inside the tool so
    //     the dispatch's own cap cannot slice the closing delimiter off. It did
    //     NOT join `UNTRUSTED_TOOL_NAMES`, so nothing here changes.
    //   - STILL OPEN, and still without its own issue: an author-composed
    //     `jarvis-ask` prompt can interpolate a step result.
    //     docs/WORKFLOW_AUTOMATION.md lists it and says so.
    //
    // WHY THE VALUE MUST NOT BE STRINGIFIED. It becomes a durable EFFECT
    // RECEIPT: service-backends.ts passes it to `effects.invoke` as the result a
    // resumed run replays instead of acting again. Using `toolReturnText` here
    // turned every object return into JSON and changed a committed receipt's
    // `result` from the tool's own value to a string of it -- caught by
    // `cancellation-authority.integration.test.ts`. `dropTrustedTrailer` touches
    // a carrier and nothing else.
    //
    // WHY THE TRAILER IS DROPPED rather than concatenated. A carrier's trailer
    // is repo-authored instructions to a model (the webapp template playbook),
    // and `browser_snapshot` is reachable here, so carriers do arrive. It must
    // not be glued onto the payload: that writes the playbook into files by the
    // same route as above, and it rebuilds the #529 shape by putting page text
    // directly against repo-authored instructions with no boundary between them.
    // A flow has no model to read a playbook, so dropping it costs nothing here.
    // See `dropTrustedTrailer` for the full argument.
    //
    // AND THE STEP IS RUN WITH DELIVERY OFF (#586), which is the other half of
    // the same sentence. Dropping the trailer stops the playbook reaching a
    // consumer that cannot use it; it does not stop the delivery being RECORDED
    // on the way here, and the tracker's 30-minute memory is shared with the
    // chat model, whose next snapshot then got nothing. A path with no model to
    // read a playbook must not spend one, so it does not resolve a template at
    // all -- checked before the lookup and before the record, in
    // `WebappTemplateDelivery.withInstructions`. It stays wrapped here, at the
    // one boundary that has already reasoned about what this path is, rather
    // than being inferred from an origin tag somewhere else.
    return dropTrustedTrailer(
      await withoutTemplateDelivery(() => this.registry.execute(name, params)),
    );
  }

  describe(name: string): PieceToolDescription | null {
    const tool = this.registry.get(name);
    if (!tool) return null;
    return {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      parameters: tool.parameters,
    };
  }

  listNames(category?: string): string[] {
    return this.registry.list(category).map((t) => t.name);
  }
}
