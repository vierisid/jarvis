import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "../hooks/useApi";
import type { MemoryProfile } from "../components/memory/MemoryDocumentCard";
import "../styles/memory.css";

const ENTITY_TYPES = ["all", "person", "project", "tool", "place", "concept", "event"] as const;

const TYPE_COLORS: Record<string, string> = {
  person: "#60A5FA",
  project: "#8B5CF6",
  tool: "#A78BFA",
  place: "#FBBF24",
  concept: "#34D399",
  event: "#22D3EE",
};

const TYPE_ICONS: Record<string, string> = {
  person: "\u{1F464}",
  project: "\u{1F4E6}",
  tool: "\u{1F527}",
  place: "\u{1F4CD}",
  concept: "\u{1F4A1}",
  event: "\u{1F4C5}",
};

// Cluster centers for constellation (percentage of container)
const CLUSTER_CENTERS: Record<string, { x: number; y: number }> = {
  person:  { x: 15, y: 25 },
  project: { x: 40, y: 15 },
  tool:    { x: 25, y: 65 },
  concept: { x: 65, y: 30 },
  event:   { x: 70, y: 65 },
  place:   { x: 50, y: 50 },
};

type View = "constellation" | "explorer";
type DetailTab = "profile" | "connections" | "conversations";

type Conversation = {
  id: string;
  agent_id: string | null;
  channel: string | null;
  started_at: number;
  last_message_at: number;
  message_count: number;
};

type DetailFact = {
  id: string;
  subject_id: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string | null;
  created_at: number;
};

type DetailRel = {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  properties: Record<string, unknown> | null;
  created_at: number;
  from_entity: { id: string; name: string; type: string };
  to_entity: { id: string; name: string; type: string };
};

// ── Helpers ──

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

function getNodeSize(factCount: number): number {
  if (factCount >= 10) return 16;
  if (factCount >= 5) return 12;
  if (factCount >= 2) return 10;
  return 8;
}

// Position entities in their type cluster with deterministic spread
function computePositions(
  profiles: MemoryProfile[],
  containerW: number,
  containerH: number,
): Map<string, { x: number; y: number; size: number }> {
  const positions = new Map<string, { x: number; y: number; size: number }>();
  // Group by type
  const byType = new Map<string, MemoryProfile[]>();
  for (const p of profiles) {
    const arr = byType.get(p.entity.type) || [];
    arr.push(p);
    byType.set(p.entity.type, arr);
  }

  for (const [type, entities] of byType) {
    const center = CLUSTER_CENTERS[type] || { x: 50, y: 50 };
    const cx = (center.x / 100) * containerW;
    const cy = (center.y / 100) * containerH;
    const spread = Math.min(containerW, containerH) * 0.18;

    for (let i = 0; i < entities.length; i++) {
      const p = entities[i]!;
      const h = hashStr(p.entity.id);
      // Golden angle spiral for nice distribution
      const angle = i * 2.399963; // golden angle in radians
      const radius = spread * Math.sqrt((i + 1) / Math.max(entities.length, 1)) * 0.8;
      // Add hash-based jitter
      const jitterX = ((h % 40) - 20);
      const jitterY = (((h >> 8) % 40) - 20);
      const x = Math.max(20, Math.min(containerW - 20, cx + Math.cos(angle) * radius + jitterX));
      const y = Math.max(20, Math.min(containerH - 20, cy + Math.sin(angle) * radius + jitterY));
      const size = getNodeSize(p.facts.length);
      positions.set(p.entity.id, { x, y, size });
    }
  }
  return positions;
}

// Build connection lines from actual relationships
function computeConnections(
  profiles: MemoryProfile[],
  positions: Map<string, { x: number; y: number; size: number }>,
): Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }> {
  const entityNames = new Map<string, string>(); // name -> id
  for (const p of profiles) entityNames.set(p.entity.name.toLowerCase(), p.entity.id);

  const lines: Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }> = [];
  const seen = new Set<string>();

  for (const p of profiles) {
    const fromPos = positions.get(p.entity.id);
    if (!fromPos) continue;
    for (const rel of p.relationships) {
      const targetId = entityNames.get(rel.target.toLowerCase());
      if (!targetId) continue;
      const toPos = positions.get(targetId);
      if (!toPos) continue;
      const key = [p.entity.id, targetId].sort().join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({
        from: p.entity.id, to: targetId,
        x1: fromPos.x + fromPos.size / 2, y1: fromPos.y + fromPos.size / 2,
        x2: toPos.x + toPos.size / 2, y2: toPos.y + toPos.size / 2,
      });
    }
  }
  return lines;
}

// ── Main Component ──

export default function MemoryPage() {
  const [view, setView] = useState<View>("constellation");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [profiles, setProfiles] = useState<MemoryProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchMemories = useCallback(async (q: string, type: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (type !== "all") params.set("type", type);
      params.set("limit", "100");
      const data = await api<MemoryProfile[]>(`/api/vault/search?${params.toString()}`);
      setProfiles(data);
    } catch { setProfiles([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchMemories(query, typeFilter); }, [query, typeFilter, fetchMemories]);

  const selectedProfile = useMemo(() =>
    profiles.find(p => p.entity.id === selectedId) || null,
  [profiles, selectedId]);

  // Stats
  const stats = useMemo(() => {
    let facts = 0, rels = 0;
    for (const p of profiles) { facts += p.facts.length; rels += p.relationships.length; }
    return { entities: profiles.length, facts, relationships: rels };
  }, [profiles]);

  // Type counts
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of profiles) counts[p.entity.type] = (counts[p.entity.type] || 0) + 1;
    return counts;
  }, [profiles]);

  return (
    <div className="mem-page">
      <div className="mem-atmosphere" />

      {/* Header */}
      <div className="mem-header">
        <span className="mem-header-title">Memory Vault</span>
        <span className="mem-header-count">{profiles.length}</span>

        <div className="mem-view-toggle">
          <button className={view === "constellation" ? "active" : ""} onClick={() => setView("constellation")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><circle cx="4" cy="4" r="1.5"/><circle cx="20" cy="8" r="1.5"/><circle cx="6" cy="20" r="1.5"/><circle cx="18" cy="18" r="1.5"/></svg>
            Constellation
          </button>
          <button className={view === "explorer" ? "active" : ""} onClick={() => setView("explorer")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            Explorer
          </button>
        </div>

        <div className="mem-header-spacer" />

        <div className="mem-search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            className="mem-search-input"
            placeholder="Search entities, facts..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="mem-loading">
          <div className="mem-loading-orb" />
          <div className="mem-loading-text">Loading memory vault...</div>
        </div>
      ) : view === "constellation" ? (
        <ConstellationView
          profiles={profiles}
          typeFilter={typeFilter}
          setTypeFilter={setTypeFilter}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          selectedProfile={selectedProfile}
          typeCounts={typeCounts}
          query={query}
        />
      ) : (
        <ExplorerView
          profiles={profiles}
          typeFilter={typeFilter}
          setTypeFilter={setTypeFilter}
          typeCounts={typeCounts}
          stats={stats}
          query={query}
        />
      )}
    </div>
  );
}

// ── Constellation View ──

function ConstellationView({ profiles, typeFilter, setTypeFilter, selectedId, setSelectedId, selectedProfile, typeCounts, query }: {
  profiles: MemoryProfile[];
  typeFilter: string;
  setTypeFilter: (t: string) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedProfile: MemoryProfile | null;
  typeCounts: Record<string, number>;
  query: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 800, h: 500 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      const e = entries[0];
      if (e) setContainerSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const positions = useMemo(() =>
    computePositions(profiles, containerSize.w, containerSize.h),
  [profiles, containerSize]);

  const connections = useMemo(() =>
    computeConnections(profiles, positions),
  [profiles, positions]);

  return (
    <div className="mem-constellation-layout">
      <div className="mem-constellation">
        {/* Type filter bar */}
        <div className="mem-cf-bar">
          {ENTITY_TYPES.map(t => (
            <button
              key={t}
              className={`mem-cf-pill${typeFilter === t ? " active" : ""}`}
              onClick={() => setTypeFilter(t)}
            >
              {t !== "all" && <span className="cp-dot" style={{ background: TYPE_COLORS[t] }} />}
              {t === "all" ? "All" : t.charAt(0).toUpperCase() + t.slice(1)}
              {t !== "all" && <span style={{ fontSize: 8, opacity: 0.5, fontFamily: "'JetBrains Mono', monospace" }}>{typeCounts[t] || 0}</span>}
            </button>
          ))}
        </div>

        {/* Star field */}
        <div className="mem-star-field" ref={containerRef}>
          <div className="mem-dot-grid" />

          {/* Connection lines */}
          <svg className="mem-conn-svg" style={{ width: "100%", height: "100%" }}>
            {connections.map((conn, i) => (
              <line
                key={i}
                x1={conn.x1} y1={conn.y1} x2={conn.x2} y2={conn.y2}
                className={selectedId && (conn.from === selectedId || conn.to === selectedId) ? "highlight" : ""}
              />
            ))}
          </svg>

          {/* Entity stars */}
          {profiles.map((p, i) => {
            const pos = positions.get(p.entity.id);
            if (!pos) return null;
            const color = TYPE_COLORS[p.entity.type] || "#8B5CF6";
            const isSelected = p.entity.id === selectedId;
            const isHighlighted = query && p.entity.name.toLowerCase().includes(query.toLowerCase());
            const scale = isSelected ? 1.8 : isHighlighted ? 1.4 : 1;
            const glow = isSelected
              ? `0 0 ${pos.size + 8}px ${color}80, 0 0 ${pos.size + 20}px ${color}30`
              : `0 0 ${pos.size}px ${color}40`;

            return (
              <div
                key={p.entity.id}
                className={`mem-star${isSelected ? " selected" : ""}`}
                style={{
                  left: pos.x,
                  top: pos.y,
                  width: pos.size,
                  height: pos.size,
                  background: color,
                  boxShadow: glow,
                  transform: `scale(${scale})`,
                  animationDelay: `${i * 0.02}s`,
                  opacity: isSelected || isHighlighted ? 1 : 0.7,
                }}
                onClick={() => setSelectedId(p.entity.id === selectedId ? null : p.entity.id)}
              >
                <span className="star-label">{p.entity.name.length > 16 ? p.entity.name.slice(0, 14) + ".." : p.entity.name}</span>
              </div>
            );
          })}

          {/* Legend */}
          <div className="mem-legend">
            {Object.entries(TYPE_COLORS).map(([type, color]) => (
              <div key={type} className="mem-legend-item">
                <div className="ldot" style={{ background: color }} />
                {type}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Detail panel */}
      <DetailPanel
        profile={selectedProfile}
        profiles={profiles}
        onSelectEntity={(id) => setSelectedId(id)}
      />
    </div>
  );
}

// ── Detail Panel ──

function DetailPanel({ profile, profiles, onSelectEntity }: {
  profile: MemoryProfile | null;
  profiles: MemoryProfile[];
  onSelectEntity: (id: string) => void;
}) {
  const [detailTab, setDetailTab] = useState<DetailTab>("profile");
  const [detailFacts, setDetailFacts] = useState<DetailFact[]>([]);
  const [detailRels, setDetailRels] = useState<DetailRel[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);

  // Fetch detailed data when entity changes
  useEffect(() => {
    if (!profile) { setDetailFacts([]); setDetailRels([]); setConversations([]); return; }
    const id = profile.entity.id;
    api<DetailFact[]>(`/api/vault/entities/${id}/facts`).then(setDetailFacts).catch(() => setDetailFacts([]));
    api<DetailRel[]>(`/api/vault/entities/${id}/relationships`).then(setDetailRels).catch(() => setDetailRels([]));
    api<Conversation[]>(`/api/vault/conversations?limit=5`).then(setConversations).catch(() => setConversations([]));
  }, [profile?.entity.id]);

  if (!profile) {
    return (
      <div className="mem-detail-panel">
        <div className="mem-no-selection">
          <div className="mem-no-selection-orb">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3 }}><circle cx="12" cy="12" r="10"/></svg>
          </div>
          <p>Select an entity to view details</p>
        </div>
      </div>
    );
  }

  const { entity, facts, relationships } = profile;
  const typeColor = TYPE_COLORS[entity.type] || "#8B5CF6";
  const entityNameMap = new Map(profiles.map(p => [p.entity.name.toLowerCase(), p.entity.id]));

  return (
    <div className="mem-detail-panel">
      <div className="mem-d-tabs">
        <button className={`mem-d-tab${detailTab === "profile" ? " active" : ""}`} onClick={() => setDetailTab("profile")}>Profile</button>
        <button className={`mem-d-tab${detailTab === "connections" ? " active" : ""}`} onClick={() => setDetailTab("connections")}>Connections</button>
        <button className={`mem-d-tab${detailTab === "conversations" ? " active" : ""}`} onClick={() => setDetailTab("conversations")}>Conversations</button>
      </div>

      <div className="mem-d-content">
        {/* Entity header (always visible) */}
        <div className="mem-d-entity-header">
          <span className="mem-type-badge" style={{ background: `${typeColor}20`, color: typeColor }}>{entity.type}</span>
          <div className="mem-d-entity-name">{entity.name}</div>
          <div className="mem-d-entity-meta">
            created {timeAgo(entity.created_at)} · updated {timeAgo(entity.updated_at)}
            {entity.source ? ` · ${entity.source}` : ""}
          </div>
        </div>

        {detailTab === "profile" && (
          <div className="mem-d-section">
            <div className="mem-d-section-label">Facts ({detailFacts.length || facts.length})</div>
            {(detailFacts.length > 0 ? detailFacts : facts.map(f => ({ ...f, subject_id: entity.id, created_at: 0, source: null }))).map((f) => (
              <div key={f.id} className="mem-d-fact">
                <span className="df-pred">{f.predicate}</span>
                <span className="df-obj">{f.object}</span>
                <span className="df-conf">{Math.round(f.confidence * 100)}%</span>
              </div>
            ))}
            {facts.length === 0 && detailFacts.length === 0 && (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.30)", padding: "8px 0" }}>No facts recorded</div>
            )}
          </div>
        )}

        {detailTab === "connections" && (
          <div className="mem-d-section">
            <div className="mem-d-section-label">Relationships ({detailRels.length || relationships.length})</div>
            {detailRels.length > 0 ? detailRels.map(r => {
              const isFrom = r.from_id === entity.id;
              const target = isFrom ? r.to_entity : r.from_entity;
              const targetColor = TYPE_COLORS[target.type] || "#8B5CF6";
              const targetProfileId = entityNameMap.get(target.name.toLowerCase());
              return (
                <div key={r.id} className="mem-d-rel" onClick={() => targetProfileId && onSelectEntity(targetProfileId)}>
                  <div className="dr-dot" style={{ background: targetColor }} />
                  <span className="dr-type">{r.type} {isFrom ? "\u2192" : "\u2190"}</span>
                  <span className="dr-name">{target.name}</span>
                  <span className="mem-type-badge" style={{ background: `${targetColor}20`, color: targetColor, marginLeft: "auto" }}>{target.type}</span>
                </div>
              );
            }) : relationships.map((rel, i) => {
              const targetColor = TYPE_COLORS["concept"] || "#8B5CF6";
              const targetProfileId = entityNameMap.get(rel.target.toLowerCase());
              return (
                <div key={i} className="mem-d-rel" onClick={() => targetProfileId && onSelectEntity(targetProfileId)}>
                  <div className="dr-dot" style={{ background: targetColor }} />
                  <span className="dr-type">{rel.type} {rel.direction === "from" ? "\u2192" : "\u2190"}</span>
                  <span className="dr-name">{rel.target}</span>
                </div>
              );
            })}
            {relationships.length === 0 && detailRels.length === 0 && (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.30)", padding: "8px 0" }}>No connections</div>
            )}
          </div>
        )}

        {detailTab === "conversations" && (
          <div className="mem-d-section">
            <div className="mem-d-section-label">Recent Conversations</div>
            {conversations.length > 0 ? conversations.map(c => (
              <div key={c.id} className="mem-d-conv">
                <div className="dc-channel">{c.channel || "dashboard"}</div>
                <div className="dc-preview">{c.message_count} messages in this conversation</div>
                <div className="dc-meta">{timeAgo(c.last_message_at)} · {c.message_count} msgs</div>
              </div>
            )) : (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.30)", padding: "8px 0" }}>No conversations found</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Explorer View ──

function ExplorerView({ profiles, typeFilter, setTypeFilter, typeCounts, stats, query }: {
  profiles: MemoryProfile[];
  typeFilter: string;
  setTypeFilter: (t: string) => void;
  typeCounts: Record<string, number>;
  stats: { entities: number; facts: number; relationships: number };
  query: string;
}) {
  return (
    <div className="mem-explorer-layout">
      {/* Type tabs */}
      <div className="mem-type-tabs">
        {ENTITY_TYPES.map(t => (
          <button
            key={t}
            className={`mem-ttab${typeFilter === t ? " active" : ""}`}
            onClick={() => setTypeFilter(t)}
          >
            {t !== "all" && <span className="tdot" style={{ background: TYPE_COLORS[t] }} />}
            {t === "all" ? "All" : t.charAt(0).toUpperCase() + t.slice(1)}
            <span className="tcount">{t === "all" ? profiles.length : (typeCounts[t] || 0)}</span>
          </button>
        ))}
        <span className="mem-tabs-spacer" />
      </div>

      {/* Grid */}
      <div className="mem-grid-area">
        {profiles.length === 0 ? (
          <div className="mem-empty">{query ? "No entities match your search" : "No entities in the vault yet"}</div>
        ) : (
          <div className="mem-entity-grid">
            {profiles.map((p, i) => (
              <EntityCard key={p.entity.id} profile={p} index={i} query={query} />
            ))}
          </div>
        )}
      </div>

      {/* Stats ribbon */}
      <div className="mem-stats-ribbon">
        <div className="mem-v-stat"><div className="mem-vs-label">Total Entities</div><div className="mem-vs-value" style={{ color: "#A78BFA" }}>{stats.entities}</div></div>
        <div className="mem-v-stat"><div className="mem-vs-label">Facts Stored</div><div className="mem-vs-value" style={{ color: "#34D399" }}>{stats.facts}</div></div>
        <div className="mem-v-stat"><div className="mem-vs-label">Relationships</div><div className="mem-vs-value" style={{ color: "#22D3EE" }}>{stats.relationships}</div></div>
      </div>
    </div>
  );
}

// ── Entity Card (Explorer) ──

function EntityCard({ profile, index, query }: { profile: MemoryProfile; index: number; query: string }) {
  const { entity, facts, relationships } = profile;
  const color = TYPE_COLORS[entity.type] || "#8B5CF6";
  const icon = TYPE_ICONS[entity.type] || "\u{1F4A1}";

  return (
    <div className="mem-entity-card" style={{ animationDelay: `${0.03 + index * 0.03}s` }}>
      <div className="mem-ec-accent" style={{ background: color }} />
      <div className="mem-ec-body">
        <div className="mem-ec-top">
          <div className="mem-ec-icon" style={{ background: `${color}18` }}>{icon}</div>
          <div className="mem-ec-info">
            <div className="mem-ec-name">{highlightText(entity.name, query)}</div>
            <div className="mem-ec-source">{entity.source || "system"} · {timeAgo(entity.updated_at)}</div>
          </div>
          <span className="mem-type-badge" style={{ background: `${color}20`, color }}>{entity.type}</span>
        </div>

        {facts.length > 0 && (
          <div className="mem-ec-facts">
            {facts.slice(0, 3).map(f => (
              <div key={f.id} className="mem-ec-fact">
                <span className="f-pred">{f.predicate}</span>
                <span className="f-obj">{f.object}</span>
              </div>
            ))}
          </div>
        )}

        <div className="mem-ec-footer">
          <span className="mem-ef-chip">{facts.length} facts</span>
          <span className="mem-ef-chip">{relationships.length} rels</span>
          <span className="mem-ef-time">{timeAgo(entity.updated_at)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Text highlighting ──

function highlightText(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} style={{ background: "rgba(139,92,246,0.25)", color: "inherit", borderRadius: 2, padding: "0 1px" }}>{part}</mark>
    ) : part
  );
}
