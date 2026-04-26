import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const POLL_INTERVAL_MS = 8000;

export type EntityType = "person" | "project" | "tool" | "place" | "concept" | "event";

export const ENTITY_TYPES: ReadonlyArray<EntityType> = [
  "person",
  "project",
  "tool",
  "place",
  "concept",
  "event",
];

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  properties: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
  source: string | null;
}

export interface Fact {
  id: string;
  subject_id: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string | null;
  created_at: number;
  verified_at: number | null;
}

export interface Relationship {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  properties: Record<string, unknown> | null;
  created_at: number;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Memory Room data hook — loads entities + facts + relationships from
 * the vault, polls every 8s (vault is mostly read-heavy), exposes
 * write actions used by both the UI and the `remember_that` voice
 * action. Per-entity facts/rels are loaded lazily when an entity is
 * selected so we don't N+1 the daemon for every grid render.
 */
export function useMemoryData() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const [eResp, fResp, rResp] = await Promise.all([
        fetch("/api/vault/entities"),
        fetch("/api/vault/facts"),
        fetch("/api/vault/relationships"),
      ]);
      if (eResp.ok) setEntities((await eResp.json()) as Entity[]);
      if (fResp.ok) setFacts((await fResp.json()) as Fact[]);
      if (rResp.ok) setRelationships((await rResp.json()) as Relationship[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memory");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const stats = useMemo(
    () => ({
      entities: entities.length,
      facts: facts.length,
      relationships: relationships.length,
    }),
    [entities, facts, relationships],
  );

  const factsBySubject = useMemo(() => {
    const map = new Map<string, Fact[]>();
    for (const f of facts) {
      const arr = map.get(f.subject_id);
      if (arr) arr.push(f);
      else map.set(f.subject_id, [f]);
    }
    return map;
  }, [facts]);

  const relsByEntity = useMemo(() => {
    const map = new Map<string, Relationship[]>();
    const push = (id: string, r: Relationship) => {
      const arr = map.get(id);
      if (arr) arr.push(r);
      else map.set(id, [r]);
    };
    for (const r of relationships) {
      push(r.from_id, r);
      push(r.to_id, r);
    }
    return map;
  }, [relationships]);

  const findByName = useCallback(
    (name: string): Entity | null => {
      const q = name.trim().toLowerCase();
      if (!q) return null;
      const exact = entities.find((e) => e.name.toLowerCase() === q);
      if (exact) return exact;
      return entities.find((e) => e.name.toLowerCase().includes(q)) ?? null;
    },
    [entities],
  );

  const addEntity = useCallback(
    async (name: string, type: EntityType): Promise<{ ok: true; entity: Entity } | { ok: false; message: string }> => {
      try {
        const resp = await fetch("/api/vault/entities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type, source: "dashboard" }),
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        const entity = (await resp.json()) as Entity;
        refresh();
        return { ok: true, entity };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const addFact = useCallback(
    async (
      subject_id: string,
      predicate: string,
      object: string,
      opts?: { confidence?: number },
    ): Promise<ActionResult> => {
      try {
        const resp = await fetch("/api/vault/facts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject_id,
            predicate,
            object,
            confidence: opts?.confidence,
            source: "dashboard",
          }),
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: "Fact added." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const addRelationship = useCallback(
    async (from_id: string, to_id: string, type: string): Promise<ActionResult> => {
      try {
        const resp = await fetch("/api/vault/relationships", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from_id, to_id, type }),
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: "Relationship added." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  /**
   * Voice path for `remember_that` — fuzzy-find the subject entity by
   * name; create as a "concept" if missing; attach the fact. The
   * predicate is taken verbatim from the classifier output (lowercased).
   */
  const rememberThat = useCallback(
    async (
      subject: string,
      predicate: string,
      object: string,
    ): Promise<ActionResult> => {
      const subjectTrim = subject.trim();
      const predicateTrim = predicate.trim().toLowerCase();
      const objectTrim = object.trim();
      if (!subjectTrim || !predicateTrim || !objectTrim) {
        return { ok: false, message: "Subject, predicate, and object are required." };
      }
      let entity = findByName(subjectTrim);
      if (!entity) {
        const created = await addEntity(subjectTrim, "concept");
        if (!created.ok) return { ok: false, message: created.message };
        entity = created.entity;
      }
      const factResult = await addFact(entity.id, predicateTrim, objectTrim);
      if (!factResult.ok) return factResult;
      return {
        ok: true,
        message: `Remembered: ${entity.name} → ${predicateTrim} → ${objectTrim}.`,
      };
    },
    [findByName, addEntity, addFact],
  );

  return {
    entities,
    facts,
    relationships,
    factsBySubject,
    relsByEntity,
    stats,
    error,
    loading,
    refresh,
    addEntity,
    addFact,
    addRelationship,
    findByName,
    rememberThat,
  };
}
