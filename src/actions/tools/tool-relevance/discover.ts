/**
 * `discover_tools` -- the way back to the full set (#483 requirement 2).
 *
 * "A filter that removes tools is only safe if the model can get them back."
 * #475 had no discovery tool, no re-filter, and no note telling the model its
 * list had been trimmed, so a wrong guess cost a capability rather than a
 * round trip: the model could not see the gap, so it substituted instead of
 * reporting it.
 *
 * This is a SYNTHETIC tool. It is never registered in the ToolRegistry:
 *   - it carries no authority of its own and must not be gateable by one;
 *   - a workflow or a sub-agent that did not opt in cannot reach it;
 *   - the registry stays the list of things that actually do something.
 *
 * It is dispatched inline at the tool loops, the way `ask_for_clarification`
 * already is. Two things that are NOT inherited from that precedent and have
 * to be done explicitly at each site (see handleDiscoverTools' contract):
 * the emergency-stop check, and an audit row. `discover_tools({names})` is
 * model-authored input that durably widens the exposed set for the rest of
 * the conversation, so it is worth a line in the trail.
 */

import type { ToolDefinition } from '../registry.ts';
import type { LLMTool } from '../../../llm/provider.ts';
import { DISCOVER_TOOLS, admittedNames, type ToolExposureLedger } from './ledger.ts';

/**
 * The model-facing schema.
 *
 * The description is where the model is told its list was trimmed. That
 * notice travels with the mechanism that answers it, so there is no prompt
 * surgery and no way for the two to drift apart.
 */
export const DISCOVER_TOOLS_DEFINITION: ToolDefinition = {
  name: DISCOVER_TOOLS,
  category: 'general',
  description:
    'Your tool list has been shortened for this conversation and some tools are hidden. '
    + 'Call this with no arguments to see every tool that exists, including the hidden ones. '
    + 'Call it with `names` to un-hide the ones you need; they become available immediately '
    + 'and stay available for the rest of the conversation. '
    + 'Use this instead of improvising with a different tool when the one you want is missing.',
  parameters: {
    names: {
      type: 'array',
      description: 'Tool names to un-hide. Omit to list the full catalogue first.',
      required: false,
    },
  },
  // Never executed: the tool loops intercept this call by name before
  // dispatch. Present so the definition satisfies ToolDefinition and so a
  // registry that somehow acquired it cannot silently do something else.
  execute: async () => 'discover_tools is handled by the agent loop, not the registry.',
};

export const DISCOVER_TOOLS_LLM: LLMTool = {
  name: DISCOVER_TOOLS_DEFINITION.name,
  description: DISCOVER_TOOLS_DEFINITION.description,
  parameters: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: DISCOVER_TOOLS_DEFINITION.parameters.names!.description,
      },
    },
    required: [],
  },
};

/** First sentence of a description, for the catalogue listing. */
function summarise(description: string): string {
  const cut = description.search(/\.\s/);
  const first = cut > 0 ? description.slice(0, cut + 1) : description;
  return first.length > 160 ? `${first.slice(0, 157)}...` : first.trim();
}

/**
 * Render the catalogue: every registered tool, marked available or hidden.
 *
 * Deliberately one line per tool rather than full schemas. The point is to
 * cost a few hundred tokens, not to hand back the 39 kB the filter just
 * saved -- a wrong guess should cost a round trip, not the whole benefit.
 */
export function buildCatalogue(
  all: readonly ToolDefinition[],
  exposed: ReadonlySet<string>,
): string {
  const lines = all.map((t) => {
    const mark = exposed.has(t.name) ? 'available' : 'hidden';
    return `- ${t.name} [${mark}]: ${summarise(t.description)}`;
  });
  return [
    `${all.length} tools exist; ${all.filter((t) => exposed.has(t.name)).length} are currently available.`,
    ...lines,
    '',
    'Call discover_tools({"names": ["tool_name", ...]}) to un-hide what you need.',
  ].join('\n');
}

export type DiscoverOutcome = {
  /** What to hand back as the tool result. */
  result: string;
  /** Names admitted, for the audit row. Empty for a plain catalogue read. */
  admitted: string[];
};

/**
 * Handle one `discover_tools` call.
 *
 * The caller is responsible, BEFORE calling this, for:
 *   - the emergency-stop check (a halted system must not enumerate its
 *     catalogue), and
 *   - writing an audit row naming `admitted`.
 *
 * Admission is not exempt from the framing invariant. Nothing is granted
 * here; names go into the ledger and the next `decideTools` recomputes and
 * re-normalises, so re-admitting `run_command` re-admits the framed readers
 * with it. A name that is not registered matches nothing and quietly does
 * nothing -- admission cannot conjure a tool into existence.
 */
export function handleDiscoverTools(
  args: unknown,
  all: readonly ToolDefinition[],
  ledger: ToolExposureLedger,
  exposed: ReadonlySet<string>,
): DiscoverOutcome {
  const requested = admittedNames(args);
  if (requested.length === 0) {
    return { result: buildCatalogue(all, exposed), admitted: [] };
  }

  const known = new Set(all.map((t) => t.name));
  const admitted = requested.filter((n) => known.has(n));
  const unknown = requested.filter((n) => !known.has(n));
  ledger.add(...admitted);

  const parts: string[] = [];
  if (admitted.length > 0) {
    parts.push(`Now available: ${admitted.join(', ')}. They are in your tool list from the next step onward.`);
  }
  if (unknown.length > 0) {
    parts.push(`No such tool: ${unknown.join(', ')}. Call discover_tools with no arguments to see the catalogue.`);
  }
  return { result: parts.join(' '), admitted };
}
