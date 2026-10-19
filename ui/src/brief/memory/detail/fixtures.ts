import type { Fact } from "../../../../../src/vault/facts";
import { MemoryController } from "../stream/controller";
import { memoryRows, FIXTURE_NOW } from "../stream/fixtures";
import { ordered, type MemoryPort, type MemoryItem } from "../stream/model";
import { MemoryDetailController } from "./controller";
import { CONFLICT, type MemoryDetail, type MemoryDetailPort } from "./model";
export const DETAIL_SCOPE = "d26-isolated-memory";
export const DETAIL_EXAMPLES = [
  "ready",
  "long",
  "many",
  "conflict",
  "save-error",
  "lost-save",
  "unavailable",
  "read-only",
  "loading",
  "no-usage",
] as const;
export type DetailExample = (typeof DETAIL_EXAMPLES)[number];
const digest = (n: number) => n.toString(16).padStart(64, "0");
export function fixtureDetail(item: MemoryItem): MemoryDetail {
  const fact: Fact = {
    id: item.factId,
    subject_id: item.subjectId,
    predicate: "email_style",
    predicate_key: "email_style",
    object: item.sentence,
    value_key: item.sentence.toLowerCase(),
    scope: item.scope,
    confidence: 0.8,
    source: item.sourceSummary.labels[0] ?? null,
    created_at: item.updatedAt,
    verified_at: null,
    valid_from: item.validity.from,
    valid_to: item.validity.to,
    status: item.status,
    superseded_by: item.supersededBy,
    basis: item.basis,
    binding_eligible: false,
    evidence: [
      {
        id: `evidence-${item.factId}`,
        fact_id: item.factId,
        source: item.sourceSummary.labels[0] ?? null,
        source_ref: "fixture:owner-conversation",
        quote: "An illustrative owner preference.",
        basis: "reported",
        confidence: 0.8,
        recorded_at: item.updatedAt,
      },
    ],
  };
  return {
    item: {
      ...item,
      // Forget is not offered until F-19 / Q-16 land on main.
      permissions: { canRead: true, canCorrect: true, canForget: false },
    },
    fact,
  };
}
/** Disposable preview/test collection only. Canonical writer integration is exercised separately against isolated SQLite. */
export function makeMemoryDetailFixture(
  example: DetailExample = "ready",
  delay = 0,
) {
  let rows = memoryRows();
  if (example === "long")
    rows[0] = {
      ...rows[0]!,
      sentence:
        "Preserve the full qualified assertion. ".repeat(80) +
        "unbroken".repeat(70),
      scope: "customer_delivery".repeat(8),
    };
  if (example === "many")
    rows = Array.from({ length: 123 }, (_, i) => ({
      ...memoryRows()[0]!,
      factId: `fixture-many-${String(i).padStart(3, "0")}`,
      sentence: `Memory ${i + 1}: A retained fixture assertion`,
      updatedAt: FIXTURE_NOW - i * 3600000,
      uses: [],
    }));
  const facts = new Map(
    rows.map((item) => {
      const detail = fixtureDetail(item);
      return [item.factId, detail];
    }),
  );
  if (example === "read-only")
    for (const d of facts.values())
      d.item.permissions = {
        canRead: true,
        canCorrect: false,
        canForget: false,
      };
  if (example === "no-usage")
    for (const d of facts.values()) d.item.uses = null;
  let revision = 20,
    writes = 0;
  const pause = async () => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  };
  const clone = <T>(value: T): T => structuredClone(value);
  const streamPort: MemoryPort = {
    source: "fixture",
    scopeId: DETAIL_SCOPE,
    async read(query) {
      await pause();
      const visible = [...facts.values()]
        .map((d) => d.item)
        .filter((item) => item.status !== "superseded");
      const matches = visible
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
        items = clone(matches.slice(offset, offset + query.limit));
      return {
        state: matches.length ? "ready" : "empty",
        asOf: FIXTURE_NOW,
        data: {
          items,
          count: {
            total: visible.length,
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
  const port: MemoryDetailPort = {
    source: "fixture",
    scopeId: DETAIL_SCOPE,
    async read(id) {
      await pause();
      if (example === "loading") return new Promise(() => {});
      if (example === "unavailable")
        return {
          state: "unavailable",
          reason: "Isolated unavailable detail example.",
        };
      const data = facts.get(id);
      return data
        ? { state: "ready", data: clone(data) }
        : { state: "missing", reason: "This fact is no longer available." };
    },
    async history(id) {
      await pause();
      const family = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const d of facts.values())
          if (
            d.item.supersededBy &&
            (family.has(d.item.factId) || family.has(d.item.supersededBy))
          ) {
            const before = family.size;
            family.add(d.item.factId);
            family.add(d.item.supersededBy);
            grew ||= family.size > before;
          }
      }
      return {
        state: "ready",
        items: clone(
          [...facts.values()]
            .filter((d) => family.has(d.item.factId))
            .map((d) => d.item),
        ),
      };
    },
    async decide(command) {
      writes++;
      await pause();
      if (example === "conflict") return CONFLICT;
      if (example === "save-error")
        return {
          state: "error",
          reason:
            "This illustrative save was rejected. Your draft is unchanged.",
        };
      const old = facts.get(command.factId);
      if (
        !old ||
        old.item.revision !== command.revision ||
        old.item.status === "superseded"
      )
        return CONFLICT;
      const id =
        command.kind === "correct" && command.object.trim() !== old.fact.object
          ? `fixture-corrected-${++revision}`
          : command.factId;
      const evidence = {
        id: `fixture-decision-${++revision}`,
        fact_id: id,
        source:
          command.kind === "correct" ? "user_correction" : "user_confirmation",
        source_ref: `fact:${command.factId}`,
        quote: command.reason.trim(),
        basis: "confirmed" as const,
        confidence: 1,
        recorded_at: FIXTURE_NOW,
      };
      const data = clone(old);
      data.fact = {
        ...data.fact,
        id,
        object:
          command.kind === "correct" ? command.object.trim() : old.fact.object,
        verified_at: FIXTURE_NOW,
        basis: "confirmed",
        status: "active",
        superseded_by: null,
        evidence:
          id === old.fact.id ? [...data.fact.evidence, evidence] : [evidence],
      };
      data.item = {
        ...data.item,
        factId: id,
        sentence: data.fact.object,
        basis: "confirmed",
        status: "active",
        revision: digest(++revision),
        updatedAt: FIXTURE_NOW,
        supersededBy: null,
        uses: id === old.fact.id ? data.item.uses : [],
        sourceSummary: {
          labels:
            id === old.fact.id
              ? [...data.item.sourceSummary.labels, evidence.source]
              : [evidence.source],
          evidenceCount: data.fact.evidence.length,
        },
      };
      if (id !== command.factId) {
        old.item.status = "superseded";
        old.item.supersededBy = id;
        old.item.revision = digest(++revision);
        old.fact.status = "superseded";
        old.fact.superseded_by = id;
      }
      facts.set(id, data);
      return example === "lost-save"
        ? {
            state: "unknown",
            reason: "The save result is unknown. Reload the current fact.",
          }
        : { state: "saved", factId: id };
    },
  };
  const stream = new MemoryController(streamPort, () => FIXTURE_NOW + 1);
  const controller = new MemoryDetailController(port, () =>
    stream.invalidate(),
  );
  return {
    stream,
    controller,
    port,
    streamPort,
    facts,
    writes: () => writes,
  };
}
