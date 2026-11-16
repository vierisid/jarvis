/**
 * What a draft's trigger (its whole step graph) must look like to be saved,
 * said in plain words. Only the basic shape and size are checked here; whether
 * the steps can run is readiness's job when the workflow is published or run.
 * A draft already saved with another shape keeps loading: this guards a save,
 * never a read.
 */
export const MAX_GRAPH_NODES = 100;

const NODE_TYPES: ReadonlySet<string> = new Set(["EMPTY", "PIECE_TRIGGER", "PIECE", "CODE", "ROUTER", "LOOP_ON_ITEMS"]);
const NOT_JARVIS = "This is not a Jarvis workflow. A workflow starts with a trigger step; build it in Jarvis or describe it in Workflows instead of pasting a file from another tool.";

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Steps reachable from the root, counted up to one past the limit so a huge graph is not walked in full. */
function nodeCount(root: Record<string, unknown>): number {
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
  while (pending.length && seen.size <= MAX_GRAPH_NODES) {
    const node = pending.pop();
    if (!isObject(node) || seen.has(node)) continue;
    seen.add(node);
    pending.push(node.nextAction, node.firstLoopAction);
    // A loop, not a spread: a spread of a very long list throws a RangeError.
    if (Array.isArray(node.children)) for (const child of node.children) pending.push(child);
  }
  return seen.size;
}

/** A plain sentence saying why this graph cannot be saved as a draft, or null when it can. */
export function refuseDraftGraph(graph: unknown): string | null {
  if (!isObject(graph)) return NOT_JARVIS;
  // A blank draft is `{}`: nothing chosen yet.
  if (Object.keys(graph).length === 0) return null;
  if (Array.isArray(graph.nodes) || isObject(graph.connections)) {
    return "This looks like a workflow file from n8n. Jarvis cannot open n8n files; build the workflow in Jarvis instead.";
  }
  if (typeof graph.type !== "string" || !NODE_TYPES.has(graph.type)) return NOT_JARVIS;
  const count = nodeCount(graph);
  if (count > MAX_GRAPH_NODES) return `This workflow has more than ${MAX_GRAPH_NODES} steps, which is the most Jarvis runs. Split it into smaller workflows.`;
  return null;
}
