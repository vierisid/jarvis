/** Most pages one read follows: 200 workflows each, so 40,000 workflows before it gives up. */
const MAX_PAGES = 200;
const PAGE = 200;
type Page = { state?: string; asOf?: number; data?: { scopeId?: string; items?: unknown[]; removals?: unknown[]; slots?: unknown[]; nextCursor?: string | null } };
/**
 * `GET /api/brief/workflows` answers one page at a time. The list room needs the complete ordered
 * collection (its search, filter and counts run over all of it), so this follows the cursors and joins
 * the pages into one answer in the shape a single read had. A page that repeats a cursor or a
 * workflow, or changes scope, is a failed read, never a quiet partial list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the joined answer is typed by its consumers, as a single read was
export async function readWorkflowPages(get: (path: string) => Promise<unknown>): Promise<Page & { data: any }> {
  let first: Page | undefined, cursor: string | null | undefined;
  const items: unknown[] = [], removals: unknown[] = [], slots: unknown[] = [], cursors = new Set<string>(), seen = new Set<string>();
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await get(`/api/brief/workflows?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`) as Page | undefined;
    const data = page?.data;
    if (!page || !["ready", "empty"].includes(page.state ?? "") || !data || !Array.isArray(data.items) || !Array.isArray(data.removals) || !Array.isArray(data.slots)) throw new Error("Workflow list unavailable");
    if (first && data.scopeId !== first.data!.scopeId) throw new Error("Workflow list changed scope");
    first ??= page;
    for (const slot of data.slots as { flowId?: unknown }[]) {
      if (typeof slot?.flowId !== "string" || seen.has(slot.flowId)) throw new Error("Workflow list repeated a workflow");
      seen.add(slot.flowId);
    }
    items.push(...data.items); removals.push(...data.removals); slots.push(...data.slots);
    cursor = data.nextCursor ?? null;
    if (!cursor) return { ...first, state: items.length || removals.length ? "ready" : "empty", data: { ...first.data, items, removals, slots, nextCursor: null } };
    if (cursors.has(cursor)) throw new Error("Workflow list repeated a page");
    cursors.add(cursor);
  }
  throw new Error("Workflow list is too long to read");
}
