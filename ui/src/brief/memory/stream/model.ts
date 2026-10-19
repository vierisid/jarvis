import type { BriefMemory } from "../../../../../src/brief/contracts";

/** Structural F17/F18 read seam. No imports from their unmerged implementations. */
export interface MemoryQuery {
  q?: string;
  source?: string;
  usedIn?: string;
  updatedFrom?: number;
  updatedBefore?: number;
  limit: number;
  cursor?: string;
}
export interface MemoryItem extends BriefMemory {
  revision: string;
  subjectId: string;
  scope: string;
  updatedAt: number;
  validity: { from: number | null; to: number | null };
  sourceSummary: { labels: string[]; evidenceCount: number };
  detailHref: string;
  historyHref: string;
  supersededBy: string | null;
}
export interface MemoryPage {
  items: MemoryItem[];
  nextCursor: string | null;
  count: { total: number; matched: number; returned: number };
  usedIn: { state: "ready" } | { state: "unavailable"; reason: string };
  usageCoverage?: {
    startedAt: number;
    retainedFrom: number;
    retentionDays: number;
    maxRecords: number;
    paths: readonly string[];
    meaning: "retained_provider_handoffs_not_model_reliance";
    completeness: "recorded_events_only";
  };
}
export type MemoryRead =
  | { state: "ready" | "empty"; data: MemoryPage; asOf: number }
  | {
      state: "stale" | "unavailable" | "unsupported" | "error";
      reason: string;
    };
export interface MemoryPort {
  source: "live" | "fixture";
  scopeId: string;
  read(query: Readonly<MemoryQuery>, signal: AbortSignal): Promise<MemoryRead>;
}
export interface MemoryFilters {
  search: string;
  source: string;
  usedIn: string;
  updated: "any" | "day" | "week" | "month";
}
export const EMPTY_FILTERS: MemoryFilters = {
  search: "",
  source: "",
  usedIn: "",
  updated: "any",
};
export const PAGE_SIZE = 50;
export function queryFor(filters: MemoryFilters, now: number): MemoryQuery {
  const q = filters.search.trim();
  if (q.length > 256 || /[\u0000-\u001f\u007f]/.test(q))
    throw new Error("Search accepts up to 256 characters.");
  if (
    filters.source.length > 4000 ||
    (filters.source !== "" && !filters.source.trim())
  )
    throw new Error("Enter an exact, nonempty source label.");
  const usedIn = filters.usedIn.trim();
  const useId = /^(conversation|run):(.+)$/.exec(usedIn)?.[2];
  if (
    usedIn &&
    (!useId ||
      useId.length > 200 ||
      /[\\/\u0000-\u001f\u007f]/.test(useId) ||
      useId === "." ||
      useId === "..")
  )
    throw new Error("Used in needs conversation:<id> or run:<id>.");
  const days = { any: 0, day: 1, week: 7, month: 30 }[filters.updated];
  return {
    limit: PAGE_SIZE,
    ...(q ? { q } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(usedIn ? { usedIn } : {}),
    ...(days ? { updatedFrom: now - days * 86400000, updatedBefore: now } : {}),
  };
}
export function queryString(query: MemoryQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return params.toString();
}
const record = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string";
const integer = (x: unknown): x is number =>
  Number.isSafeInteger(x) && (x as number) >= 0;
const timestamp = (x: unknown): x is number =>
  Number.isSafeInteger(x) && Math.abs(x as number) <= 8.64e15;
/** Reject unreadable/ambiguous pages as a whole: filtering them would falsify exact counts. */
export function validPage(
  page: unknown,
  query: MemoryQuery,
): page is MemoryPage {
  if (
    !record(page) ||
    !Array.isArray(page.items) ||
    page.items.length > query.limit ||
    !record(page.count)
  )
    return false;
  const { total, matched, returned } = page.count;
  if (
    ![total, matched, returned].every(integer) ||
    total < matched ||
    matched < returned ||
    returned !== page.items.length
  )
    return false;
  if (
    page.nextCursor !== null &&
    (!text(page.nextCursor) || !page.nextCursor || returned === 0)
  )
    return false;
  if (
    !record(page.usedIn) ||
    !["ready", "unavailable"].includes(page.usedIn.state)
  )
    return false;
  const ids = new Set<string>();
  for (const row of page.items) {
    if (
      !record(row) ||
      !text(row.factId) ||
      !row.factId ||
      ids.has(row.factId) ||
      !text(row.revision) ||
      !row.revision ||
      !text(row.sentence) ||
      !text(row.scope) ||
      !timestamp(row.updatedAt) ||
      !record(row.permissions) ||
      row.permissions.canRead !== true ||
      typeof row.permissions.canCorrect !== "boolean" ||
      typeof row.permissions.canForget !== "boolean" ||
      !["active", "contested"].includes(row.status) ||
      ![
        "confirmed",
        "reported",
        "observed",
        "inferred",
        "unspecified",
      ].includes(row.basis) ||
      !Array.isArray(row.provenance) ||
      !record(row.sourceSummary) ||
      !Array.isArray(row.sourceSummary.labels) ||
      !row.sourceSummary.labels.every(text) ||
      !integer(row.sourceSummary.evidenceCount) ||
      !record(row.validity) ||
      ![row.validity.from, row.validity.to].every(
        (x) => x === null || timestamp(x),
      )
    )
      return false;
    if (
      row.uses !== null &&
      (!Array.isArray(row.uses) ||
        !row.uses.every(
          (use: any) =>
            record(use) &&
            use.factId === row.factId &&
            text(use.useId) &&
            text(use.sourceRevision) &&
            ["selected", "supplied", "outcome_verified"].includes(use.stage) &&
            timestamp(use.at) &&
            (use.runId === null || text(use.runId)) &&
            (use.turn === null ||
              (record(use.turn) && text(use.turn.conversationId))),
        ))
    )
      return false;
    ids.add(row.factId);
  }
  return page.items.every((row, i) => !i || ordered(page.items[i - 1], row));
}
export function ordered(a: MemoryItem, b: MemoryItem) {
  return (
    a.updatedAt > b.updatedAt ||
    (a.updatedAt === b.updatedAt && a.factId < b.factId)
  );
}
export function dateGroup(at: number, now: number) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return at >= today.getTime()
    ? "Today"
    : at >= yesterday.getTime()
      ? "Yesterday"
      : "Earlier";
}
export function usageLabel(row: MemoryItem) {
  if (row.uses === null) return "Usage unavailable";
  const supplied = row.uses.filter((use) => use.stage !== "selected");
  if (!supplied.length)
    return row.uses.length
      ? "Selected only · not supplied"
      : "No retained use recorded";
  const runs = new Set(
    supplied.flatMap((use) => (use.runId ? [use.runId] : [])),
  );
  const chats = new Set(
    supplied.flatMap((use) => (use.turn ? [use.turn.conversationId] : [])),
  );
  return (
    [
      runs.size ? `${runs.size} run${runs.size === 1 ? "" : "s"}` : "",
      chats.size
        ? `${chats.size} conversation${chats.size === 1 ? "" : "s"}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ") + " · recorded supply"
  );
}
