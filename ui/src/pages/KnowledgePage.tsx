import React, { useState, useMemo } from "react";
import { useApiData } from "../hooks/useApi";
import "../styles/knowledge.css";

type Entity = {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
  source: string | null;
};

type Fact = {
  id: string;
  subject_id: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string | null;
  created_at: number;
};

type RelWithEntities = {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  properties: Record<string, unknown> | null;
  created_at: number;
  from_entity: { id: string; name: string; type: string };
  to_entity: { id: string; name: string; type: string };
};

const ENTITY_TYPES = ["all", "person", "project", "tool", "place", "concept", "event"] as const;

const TYPE_COLORS: Record<string, string> = {
  person: "#60A5FA",
  project: "#8B5CF6",
  tool: "#A78BFA",
  place: "#FBBF24",
  concept: "#34D399",
  event: "#22D3EE",
};

export default function KnowledgePage() {
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Build entity query
  const entityParams = useMemo(() => {
    const p = new URLSearchParams();
    if (typeFilter !== "all") p.set("type", typeFilter);
    if (search) p.set("q", search);
    return p.toString();
  }, [typeFilter, search]);

  const { data: entities, loading: entitiesLoading } = useApiData<Entity[]>(
    `/api/vault/entities${entityParams ? `?${entityParams}` : ""}`,
    [entityParams]
  );

  // Fetch facts + relationships for selected entity
  const { data: facts, loading: factsLoading } = useApiData<Fact[]>(
    selectedId ? `/api/vault/entities/${selectedId}/facts` : null,
    [selectedId]
  );

  const { data: rels, loading: relsLoading } = useApiData<RelWithEntities[]>(
    selectedId ? `/api/vault/entities/${selectedId}/relationships` : null,
    [selectedId]
  );

  const selectedEntity = useMemo(() =>
    entities?.find(e => e.id === selectedId) || null,
  [entities, selectedId]);

  // Navigate to an entity by clicking a relationship
  const handleNavigateToEntity = (entityId: string) => {
    setSelectedId(entityId);
  };

  return (
    <div className="kb-page">
      <div className="kb-atmosphere" />

      {/* Header */}
      <div className="kb-header">
        <span className="kb-header-title">Knowledge Browser</span>
        <span className="kb-header-count">{entities?.length ?? 0}</span>
        <div className="kb-header-spacer" />
      </div>

      {/* Three columns */}
      <div className="kb-columns">

        {/* Entities column */}
        <div className="kb-col kb-col-entities">
          <div className="kb-col-header">
            <span className="kb-col-title">Entities</span>
            <span className="kb-col-count">{entities?.length ?? 0}</span>
          </div>
          <div className="kb-col-search">
            <input
              placeholder="Search..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="kb-type-filters">
            {ENTITY_TYPES.map(t => (
              <button
                key={t}
                className={`kb-type-filter${typeFilter === t ? " active" : ""}`}
                onClick={() => setTypeFilter(t)}
              >
                {t === "all" ? "All" : t}
              </button>
            ))}
          </div>
          <div className="kb-col-body">
            {entitiesLoading && <div className="kb-loading">Loading...</div>}
            {!entitiesLoading && entities && entities.length === 0 && (
              <div className="kb-empty">No entities found</div>
            )}
            {entities?.map(entity => {
              const color = TYPE_COLORS[entity.type] || "#8B5CF6";
              return (
                <div
                  key={entity.id}
                  className={`kb-entity${entity.id === selectedId ? " selected" : ""}`}
                  onClick={() => setSelectedId(entity.id)}
                >
                  <div className="ke-dot" style={{ background: color }} />
                  <span className="ke-name">{entity.name}</span>
                  <span className="ke-type">{entity.type}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Facts column */}
        <div className="kb-col kb-col-facts">
          <div className="kb-col-header">
            <span className="kb-col-title">Facts</span>
            <span className="kb-col-count">{facts?.length ?? 0}</span>
          </div>
          <div className="kb-col-body">
            {!selectedId && <div className="kb-empty">Select an entity</div>}
            {selectedId && factsLoading && <div className="kb-loading">Loading facts...</div>}
            {selectedId && !factsLoading && facts && facts.length === 0 && (
              <div className="kb-empty">No facts recorded</div>
            )}
            {facts?.map((fact, i) => {
              const confPct = Math.round(fact.confidence * 100);
              const confColor = confPct >= 90 ? "#34D399" : confPct >= 70 ? "#FBBF24" : "#FB7185";
              return (
                <div key={fact.id} className="kb-fact" style={{ animationDelay: `${i * 0.03}s` }}>
                  <div className="kf-pred">{fact.predicate}</div>
                  <div className="kf-obj">{fact.object}</div>
                  <div className="kf-meta">
                    <span>{confPct}%</span>
                    <span className="kf-conf-bar"><span className="kf-conf-fill" style={{ width: `${confPct}%`, background: confColor }} /></span>
                    {fact.source && <span>{fact.source}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Relationships column */}
        <div className="kb-col kb-col-rels">
          <div className="kb-col-header">
            <span className="kb-col-title">Relationships</span>
            <span className="kb-col-count">{rels?.length ?? 0}</span>
          </div>
          <div className="kb-col-body">
            {!selectedId && <div className="kb-empty">Select an entity</div>}
            {selectedId && relsLoading && <div className="kb-loading">Loading...</div>}
            {selectedId && !relsLoading && rels && rels.length === 0 && (
              <div className="kb-empty">No relationships found</div>
            )}
            {rels?.map((rel, i) => {
              const isFrom = rel.from_id === selectedId;
              const other = isFrom ? rel.to_entity : rel.from_entity;
              const otherColor = TYPE_COLORS[other.type] || "#8B5CF6";
              return (
                <div
                  key={rel.id}
                  className="kb-rel"
                  style={{ animationDelay: `${i * 0.03}s` }}
                  onClick={() => handleNavigateToEntity(other.id)}
                >
                  <div className="kr-dot" style={{ background: otherColor }} />
                  <span className="kr-type">{rel.type}</span>
                  <span className="kr-arrow">{isFrom ? "\u2192" : "\u2190"}</span>
                  <span className="kr-name">{other.name}</span>
                  <span className="kr-etype">{other.type}</span>
                  <span className="kr-nav">Go &rarr;</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
