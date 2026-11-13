import type { ManagementSlot } from "./controller";

/** Rows drawn at once. The rest stay behind "Show more" so a long list does not
 * put thousands of nodes on the page. */
export const PAGE_SIZE = 50;

export type StateFilter = "all" | "on" | "off" | "setup";
export const STATE_FILTERS: readonly { value: StateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
  { value: "setup", label: "Needs setup" },
];

/** Case-insensitive match on the workflow name, ignoring extra spaces. */
export function matchesQuery(name: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = name.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function matchesState(row: ManagementSlot, filter: StateFilter) {
  const w = row.item;
  if (filter === "on") return w.activation === "ENABLED";
  if (filter === "off") return w.activation === "DISABLED";
  if (filter === "setup") return w.readiness.state === "blocked";
  return true;
}

/** What the All workflows list is narrowed to. Held by the controller so it
 * survives leaving the room, like the scroll position. `keep` lists rows the
 * founder acted on since the search or filter last changed. */
export interface ListViewPrefs {
  query: string;
  filter: StateFilter;
  limit: number;
  keep: readonly string[];
}
export const DEFAULT_VIEW: ListViewPrefs = {
  query: "",
  filter: "all",
  limit: PAGE_SIZE,
  keep: [],
};

export interface ListView {
  /** Rows to draw: matching live rows up to the limit, plus every row that must
   * stay in sight whatever the search, filter or page: removed rows (collapse
   * and Undo), rows waiting on a confirm, a command or a reconcile, and rows the
   * founder acted on, so a paused row does not vanish from "On" with its
   * outcome unread. */
  rows: ManagementSlot[];
  /** Live rows that match the search and filter. */
  matching: number;
  /** Live rows in the whole list. */
  total: number;
}

export function buildListView(
  rows: readonly ManagementSlot[],
  query: string,
  filter: StateFilter,
  limit: number,
  keep: ReadonlySet<string> = new Set(),
): ListView {
  const out: ManagementSlot[] = [];
  let matching = 0,
    total = 0;
  for (const r of rows) {
    if (r.removed) {
      out.push(r);
      continue;
    }
    total++;
    const pinned =
      r.confirming || r.phase !== "idle" || keep.has(r.item.flowId);
    if (!matchesQuery(r.item.name, query) || !matchesState(r, filter)) {
      if (pinned) out.push(r);
      continue;
    }
    matching++;
    if (matching <= limit || pinned) out.push(r);
  }
  return { rows: out, matching, total };
}
