import { MemoryController } from "./controller";
import {
  ordered,
  type MemoryItem,
  type MemoryPort,
  type MemoryQuery,
  type MemoryRead,
} from "./model";
export const MEMORY_SCOPE = "d25-isolated-memory";
export const MEMORY_EXAMPLES = [
  "ready",
  "loading",
  "empty",
  "stale",
  "error",
  "unavailable",
  "unsupported",
  "long",
  "many",
  "no-usage",
] as const;
export type MemoryExample = (typeof MEMORY_EXAMPLES)[number];
export const FIXTURE_NOW = new Date(2026, 9, 12, 12).getTime();
export function memoryRows(): MemoryItem[] {
  return [
    "Keep emails short. One clear next step.",
    "Start every pilot with a clear scope and success criteria.",
    "We build for busy founders.",
    "Track pricing and onboarding changes.",
    "Investor updates should be concise and candid.",
    "Alex owns the pilot decision.",
  ].map((sentence, i) => ({
    factId: `fixture-memory-${i}`,
    sourceId: null,
    sentence,
    basis: "reported",
    status: "active",
    revision: `revision-${i}`,
    subjectId: `fixture-subject-${i}`,
    scope: i === 0 ? "work" : "",
    updatedAt: FIXTURE_NOW - Math.floor(i / 2) * 86400000,
    validity: { from: null, to: null },
    sourceSummary: {
      labels: [i % 2 ? "Meeting notes" : "Conversation"],
      evidenceCount: 1,
    },
    provenance: [],
    permissions: { canRead: true, canCorrect: false, canForget: false },
    uses: [
      {
        useId: `fixture-use-${i}`,
        factId: `fixture-memory-${i}`,
        sourceRevision: `source-revision-${i}`,
        stage: i === 4 ? "selected" : "supplied",
        turn: null,
        runId: "fixture-follow-up",
        at: FIXTURE_NOW,
      },
    ],
    detailHref: `/api/brief/memory/fixture-memory-${i}`,
    historyHref: `/api/brief/memory/fixture-memory-${i}/history`,
    supersededBy: null,
  }));
}
/** Test/preview only: complete isolated collection queried behind the same bounded port. No network or vault. */
export function makeMemoryFixture(example: MemoryExample = "ready", delay = 0) {
  let rows = example === "empty" ? [] : memoryRows();
  if (example === "long")
    rows[0] = {
      ...rows[0]!,
      sentence:
        "A long qualified fact: " +
        "preserve the full sentence and evidence ".repeat(80) +
        "unbroken".repeat(70),
      scope: "customer_delivery".repeat(8),
      status: "contested",
      basis: "inferred",
    };
  if (example === "many")
    rows = Array.from({ length: 123 }, (_, i) => ({
      ...memoryRows()[0]!,
      factId: `fixture-many-${String(i).padStart(3, "0")}`,
      sentence: `Memory ${i + 1}: ${i === 122 ? "needle beyond the first page" : "A retained fixture assertion"}`,
      updatedAt: FIXTURE_NOW - i * 3600000,
      uses: [],
    }));
  if (example === "no-usage")
    rows = rows.map((row) => ({ ...row, uses: null }));
  const requests: MemoryQuery[] = [];
  const port: MemoryPort = {
    source: "fixture",
    scopeId: MEMORY_SCOPE,
    async read(query): Promise<MemoryRead> {
      requests.push({ ...query });
      if (example === "loading") return new Promise(() => {});
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (["stale", "error", "unavailable", "unsupported"].includes(example))
        return {
          state: example as "stale" | "error" | "unavailable" | "unsupported",
          reason: `Isolated ${example} example. Refresh retains the applied filters.`,
        };
      if (query.usedIn && example === "no-usage")
        return {
          state: "unavailable",
          reason: "Recorded usage is unavailable.",
        };
      const matches = rows
        .filter(
          (row) =>
            (!query.q ||
              row.sentence.toLowerCase().includes(query.q.toLowerCase())) &&
            (!query.source ||
              row.sourceSummary.labels.includes(query.source)) &&
            (!query.usedIn ||
              row.uses?.some(
                (use) =>
                  use.stage !== "selected" &&
                  (query.usedIn === `run:${use.runId}` ||
                    query.usedIn ===
                      `conversation:${use.turn?.conversationId}`),
              )) &&
            (query.updatedFrom === undefined ||
              row.updatedAt >= query.updatedFrom) &&
            (query.updatedBefore === undefined ||
              row.updatedAt < query.updatedBefore),
        )
        .sort((a, b) => (ordered(a, b) ? -1 : 1));
      const offset = Number(query.cursor ?? 0),
        items = matches.slice(offset, offset + query.limit);
      return {
        state: matches.length ? "ready" : "empty",
        asOf: FIXTURE_NOW,
        data: {
          items,
          count: {
            total: rows.length,
            matched: matches.length,
            returned: items.length,
          },
          nextCursor:
            offset + items.length < matches.length
              ? String(offset + items.length)
              : null,
          usedIn:
            example === "no-usage"
              ? { state: "unavailable", reason: "provider_unavailable" }
              : { state: "ready" },
        },
      };
    },
  };
  return {
    controller: new MemoryController(port, () => FIXTURE_NOW + 1),
    port,
    requests,
  };
}
