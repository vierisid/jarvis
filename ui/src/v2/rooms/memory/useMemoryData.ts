import { readMemoryPages } from './memory-pages';
import { matchEntityByName } from "../../../../../src/daemon/room-action-targets";
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

export type { Fact } from '../../../../../src/vault/facts';
import type { Fact } from '../../../../../src/vault/facts';

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
  const inFlightRef = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (!mounted.current || document.hidden || inFlightRef.current) return;
    const controller = new AbortController();
    inFlightRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const [entities, facts, relationships] = await Promise.all([
        readMemoryPages<Entity>('entities', controller.signal),
        readMemoryPages<Fact>('facts', controller.signal),
        readMemoryPages<Relationship>('relationships', controller.signal),
      ]);
      if (!mounted.current || controller.signal.aborted) return;
      setEntities(entities); setFacts(facts); setRelationships(relationships);
      setError(null);
    } catch (err) {
      if (mounted.current && !document.hidden && controller.signal.reason !== 'hidden') setError(controller.signal.aborted
        ? "Memory refresh timed out; showing the previous snapshot."
        : err instanceof Error ? err.message : "Failed to load memory");
    } finally {
      controller.abort(); // Cancel sibling page readers after any failed page.
      window.clearTimeout(timer);
      if (inFlightRef.current === controller) inFlightRef.current = null;
      if (mounted.current) setLoading(false);
      if (mounted.current && !document.hidden && controller.signal.reason === 'hidden') queueMicrotask(() => void refresh());
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const visibility = () => {
      if (document.hidden) inFlightRef.current?.abort('hidden');
      else void refresh();
    };
    window.addEventListener('vault-facts-updated', refresh);
    document.addEventListener('visibilitychange', visibility);
    const id = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      inFlightRef.current?.abort();
      window.clearInterval(id);
      window.removeEventListener('vault-facts-updated', refresh);
      document.removeEventListener('visibilitychange', visibility);
    };
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
   * Voice path for `remember_that`: attach the fact to its subject entity,
   * the predicate lowercased.
   *
   * `entity` is what the daemon settled on before the person approved the
   * card (#1023), taken as given: an id is that entity (a missing one is
   * refused, never swapped for another), and "new" creates one by the
   * subject's name, unless one by that name has appeared since the card,
   * which is refused. With neither (the realtime path, which holds
   * no card) the subject is matched as the daemon matches it, against the
   * vault's own list rather than whatever this room has loaded so far:
   * a name that matches two entities is refused, and one that matches none
   * creates a "concept".
   */
  const rememberThat = useCallback(
    async (
      subject: string,
      predicate: string,
      object: string,
      entity: { id: string } | "new" | null = null,
    ): Promise<ActionResult> => {
      const subjectTrim = subject.trim();
      const predicateTrim = predicate.trim().toLowerCase();
      const objectTrim = object.trim();
      if (!subjectTrim || !predicateTrim || !objectTrim) {
        return { ok: false, message: "Subject, predicate, and object are required." };
      }
      let target: { id: string; name: string } | null = entity && entity !== "new" ? { id: entity.id, name: subjectTrim } : null;
      if (!target) {
        try {
          const resp = await fetch("/api/vault/entities");
          if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
          const match = matchEntityByName(await resp.json() as Entity[], subjectTrim);
          // The card said a new entity; one by that name was made since (say
          // by another card), so neither a second one nor that one is what
          // was approved.
          if (entity === "new" && match) {
            return { ok: false, message: `${subjectTrim} was added to memory since I asked; nothing was saved. Say it again.` };
          }
          if (match && "ambiguous" in match) {
            return { ok: false, message: `${match.ambiguous} entities match "${subjectTrim}"; add the fact from the entity itself.` };
          }
          if (match) target = match.entity;
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : "Failed" };
        }
      }
      if (!target) {
        const created = await addEntity(subjectTrim, "concept");
        if (!created.ok) return { ok: false, message: created.message };
        target = created.entity;
      }
      const factResult = await addFact(target.id, predicateTrim, objectTrim);
      // A pinned entity deleted since the card is not swapped for another.
      if (!factResult.ok && /Unknown subject_id/.test(factResult.message)) {
        return { ok: false, message: `${target.name} is no longer in memory; nothing was saved.` };
      }
      if (!factResult.ok) return factResult;
      return {
        ok: true,
        message: `Remembered: ${target.name} → ${predicateTrim} → ${objectTrim}.`,
      };
    },
    [addEntity, addFact],
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
