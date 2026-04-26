import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Briefcase,
  Calendar,
  Lightbulb,
  Locate,
  MapPin,
  RefreshCw,
  Search,
  Sparkles,
  User,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Chip, Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import { useRovingTabs } from "../useRovingTabs";
import {
  useMemoryData,
  type Entity,
  type EntityType,
  type Fact,
  type Relationship,
} from "./useMemoryData";
import "./MemoryRoom.css";

type TabId = "constellation" | "explorer" | "browser";

const TAB_LABEL: Record<TabId, string> = {
  constellation: "Constellation",
  explorer: "Explorer",
  browser: "Browser",
};

const TYPE_LABEL: Record<EntityType, string> = {
  person: "People",
  project: "Projects",
  tool: "Tools",
  place: "Places",
  concept: "Concepts",
  event: "Events",
};

const TYPE_ICON: Record<EntityType, LucideIcon> = {
  person: User,
  project: Briefcase,
  tool: Wrench,
  place: MapPin,
  concept: Lightbulb,
  event: Calendar,
};

// Hand-positioned cluster centers — preserved from legacy MemoryPage.
const CLUSTER_CENTERS: Record<EntityType, { x: number; y: number }> = {
  person: { x: 18, y: 28 },
  project: { x: 42, y: 18 },
  tool: { x: 26, y: 66 },
  concept: { x: 66, y: 30 },
  event: { x: 72, y: 66 },
  place: { x: 50, y: 50 },
};

export type RoomBodyMode = "inline" | "expanded";

export function MemoryRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useMemoryData();
  const [activeTab, setActiveTab] = useState<TabId>("constellation");
  const TAB_KEYS = useMemo(() => Object.keys(TAB_LABEL) as TabId[], []);
  const tabsApi = useRovingTabs<TabId>(TAB_KEYS, activeTab, setActiveTab, "v2-mem");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<EntityType | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const filteredEntities = useMemo(() => {
    let list = data.entities;
    if (typeFilter !== "all") list = list.filter((e) => e.type === typeFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((e) => {
        if (e.name.toLowerCase().includes(q)) return true;
        const facts = data.factsBySubject.get(e.id) ?? [];
        return facts.some(
          (f) =>
            f.predicate.toLowerCase().includes(q) ||
            f.object.toLowerCase().includes(q),
        );
      });
    }
    return list;
  }, [data.entities, data.factsBySubject, search, typeFilter]);

  const selectedEntity = useMemo(
    () => (selectedId ? data.entities.find((e) => e.id === selectedId) ?? null : null),
    [data.entities, selectedId],
  );

  const typeCounts = useMemo(() => {
    const out: Record<EntityType | "all", number> = {
      all: data.entities.length,
      person: 0,
      project: 0,
      tool: 0,
      place: 0,
      concept: 0,
      event: 0,
    };
    for (const e of data.entities) out[e.type]++;
    return out;
  }, [data.entities]);

  // Phase 6.3.5 — voice room actions.
  useRoomActions("memory", (action, args) => {
    switch (action) {
      case "switch_tab": {
        const t = String(args.tab);
        if (t === "constellation" || t === "explorer" || t === "browser") {
          setActiveTab(t);
          return true;
        }
        return false;
      }
      case "search":
        setSearch(typeof args.query === "string" ? args.query : "");
        return true;
      case "set_filter": {
        const f = String(args.type);
        if (f === "all") {
          setTypeFilter("all");
          return true;
        }
        if ((["person", "project", "tool", "place", "concept", "event"] as EntityType[]).includes(f as EntityType)) {
          setTypeFilter(f as EntityType);
          return true;
        }
        return false;
      }
      case "select": {
        const name = typeof args.name === "string" ? args.name : "";
        const ent = data.findByName(name);
        if (!ent) return false;
        setSelectedId(ent.id);
        return true;
      }
      case "remember_that": {
        const subject = typeof args.subject === "string" ? args.subject : "";
        const predicate = typeof args.predicate === "string" ? args.predicate : "";
        const object = typeof args.object === "string" ? args.object : "";
        if (!subject || !predicate || !object) return false;
        // Fire-and-forget; the rememberThat helper toasts on success/failure.
        (async () => {
          const r = await data.rememberThat(subject, predicate, object);
          setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      default:
        return false;
    }
  });

  return (
    <div className={`v2-mem v2-mem--${mode}`}>
      {/* Stats */}
      <div className="v2-mem__stats">
        <StatCard label="Entities" value={data.stats.entities} sub={`${typeCounts.person} people · ${typeCounts.project} projects`} />
        <StatCard label="Facts" value={data.stats.facts} sub="across all entities" />
        <StatCard label="Relationships" value={data.stats.relationships} sub="links between entities" />
        <StatCard label="Selected" value={selectedEntity ? selectedEntity.name : "—"} sub={selectedEntity ? selectedEntity.type : "no selection"} />
      </div>

      {/* Tabs */}
      {mode === "expanded" && (
        <div
          className="v2-mem__tabs"
          role="tablist"
          aria-label="Memory view"
          ref={tabsApi.tablistRef}
        >
          {TAB_KEYS.map((t) => (
            <button
              key={t}
              type="button"
              className="v2-mem__tab"
              data-active={activeTab === t}
              {...tabsApi.getTabProps(t)}
            >
              <span>{TAB_LABEL[t]}</span>
              {t === "constellation" && (
                <span className="v2-mem__tab-badge">{filteredEntities.length}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="v2-mem__toolbar">
        <div className="v2-mem__search">
          <Icon icon={Search} size="sm" />
          <input
            className="v2-mem__search-input"
            type="text"
            placeholder="Search entities, facts, predicates…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search memory"
          />
        </div>
        <div className="v2-mem__filter-row" role="tablist" aria-label="Filter by entity type">
          <button
            type="button"
            className="v2-mem__filter-btn"
            data-active={typeFilter === "all"}
            onClick={() => setTypeFilter("all")}
          >
            All <span className="v2-mem__filter-count">{typeCounts.all}</span>
          </button>
          {(Object.keys(TYPE_LABEL) as EntityType[]).map((t) => (
            <button
              key={t}
              type="button"
              className="v2-mem__filter-btn"
              data-active={typeFilter === t}
              onClick={() => setTypeFilter(t)}
            >
              <Icon icon={TYPE_ICON[t]} size="sm" />
              <span>{TYPE_LABEL[t]}</span>
              <span className="v2-mem__filter-count">{typeCounts[t]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="v2-mem__refresh"
          onClick={data.refresh}
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon icon={RefreshCw} size="sm" />
        </button>
      </div>

      {data.error && <div className="v2-mem__error">{data.error}</div>}

      {/* Content */}
      {(mode === "inline" || activeTab === "constellation") && (
        <Constellation
          entities={filteredEntities}
          factsBySubject={data.factsBySubject}
          relsByEntity={data.relsByEntity}
          allEntities={data.entities}
          relationships={data.relationships}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}
      {mode === "expanded" && activeTab === "explorer" && (
        <Explorer
          entities={filteredEntities}
          factsBySubject={data.factsBySubject}
          relsByEntity={data.relsByEntity}
          allEntities={data.entities}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={data.loading}
        />
      )}
      {mode === "expanded" && activeTab === "browser" && (
        <Browser
          entities={filteredEntities}
          factsBySubject={data.factsBySubject}
          relsByEntity={data.relsByEntity}
          allEntities={data.entities}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      {toast && (
        <div role="status" aria-live="polite" className="v2-mem__toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export function MemoryRoom() {
  return (
    <RoomShell
      title="Memory"
      subtitle="entities · facts · relationships"
      breadcrumb={["Memory"]}
    >
      <MemoryRoomBody mode="expanded" />
    </RoomShell>
  );
}

/* ─────────── Stat card ─────────── */

function StatCard({ label, value, sub }: { label: string; value: number | string; sub: string }) {
  return (
    <div className="v2-mem__stat">
      <div className="v2-mem__stat-label">{label}</div>
      <div className="v2-mem__stat-value">{value}</div>
      <div className="v2-mem__stat-sub">{sub}</div>
    </div>
  );
}

/* ─────────── Constellation tab ─────────── */

/** Min/max zoom — picked so labels stay readable at the limits without
 *  letting the user zoom past usefulness. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

function Constellation({
  entities,
  factsBySubject,
  relsByEntity,
  allEntities,
  relationships,
  selectedId,
  onSelect,
}: {
  entities: Entity[];
  factsBySubject: Map<string, Fact[]>;
  relsByEntity: Map<string, Relationship[]>;
  allEntities: Entity[];
  relationships: Relationship[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // viewBox state — { x, y, zoom }. zoom is the inverse of viewBox scale
  // (zoom 2 means we're seeing half the area of the canvas → 2x zoomed in).
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ pointerX: number; pointerY: number; viewX: number; viewY: number } | null>(null);

  // ResizeObserver — keeps the canvas dimensions current as the user
  // resizes the Room overlay or the floating window.
  useEffect(() => {
    if (!stageRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: width, h: height });
    });
    obs.observe(stageRef.current);
    return () => obs.disconnect();
  }, []);

  // Position computation — golden-angle spiral per type cluster, ported
  // from legacy MemoryPage with deterministic hash-based jitter.
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; size: number }>();
    const byType = new Map<EntityType, Entity[]>();
    for (const e of entities) {
      const arr = byType.get(e.type);
      if (arr) arr.push(e);
      else byType.set(e.type, [e]);
    }
    for (const [type, list] of byType) {
      const center = CLUSTER_CENTERS[type] ?? { x: 50, y: 50 };
      const cx = (center.x / 100) * size.w;
      const cy = (center.y / 100) * size.h;
      const spread = Math.min(size.w, size.h) * 0.18;
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!;
        const h = hashStr(e.id);
        const angle = i * 2.399963; // golden angle
        const radius = spread * Math.sqrt((i + 1) / Math.max(list.length, 1)) * 0.8;
        const jx = (h % 40) - 20;
        const jy = ((h >> 8) % 40) - 20;
        const x = Math.max(20, Math.min(size.w - 20, cx + Math.cos(angle) * radius + jx));
        const y = Math.max(20, Math.min(size.h - 20, cy + Math.sin(angle) * radius + jy));
        const facts = factsBySubject.get(e.id)?.length ?? 0;
        const r = facts >= 10 ? 9 : facts >= 5 ? 7 : facts >= 2 ? 6 : 5;
        map.set(e.id, { x, y, size: r });
      }
    }
    return map;
  }, [entities, size.w, size.h, factsBySubject]);

  // Connection lines — pull from relationships limited to visible entities.
  const lines = useMemo(() => {
    const visible = new Set(entities.map((e) => e.id));
    const seen = new Set<string>();
    const out: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }> = [];
    for (const r of relationships) {
      if (!visible.has(r.from_id) || !visible.has(r.to_id)) continue;
      const key = [r.from_id, r.to_id].sort().join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      const a = positions.get(r.from_id);
      const b = positions.get(r.to_id);
      if (!a || !b) continue;
      out.push({ key, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    return out;
  }, [entities, relationships, positions]);

  // ── Pan/zoom handlers ──

  const resetView = useCallback(() => {
    setView({ x: 0, y: 0, zoom: 1 });
  }, []);

  // Wheel zoom — zoom toward the cursor so the point under the pointer
  // stays put. ctrlKey is the trackpad pinch convention; without it,
  // wheel still zooms (most users expect this in graph editors).
  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    setView((prev) => {
      // Convert wheel delta into a zoom factor. Trackpad pinch (small
      // deltas) and mouse wheel (deltaMode=1, line-based) both feel
      // natural with this scale.
      const factor = Math.exp(-e.deltaY * 0.0015);
      const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev.zoom * factor));
      if (nextZoom === prev.zoom) return prev;
      // Convert pointer to canvas coords at the OLD zoom.
      const canvasX = prev.x + px / prev.zoom;
      const canvasY = prev.y + py / prev.zoom;
      // Adjust origin so the same canvas point stays under the pointer.
      const nextX = canvasX - px / nextZoom;
      const nextY = canvasY - py / nextZoom;
      return { x: nextX, y: nextY, zoom: nextZoom };
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Only left mouse button or touch.
    if (e.button !== 0 && e.pointerType === "mouse") return;
    // Don't hijack node clicks — they bubble up here too.
    if ((e.target as HTMLElement).closest(".v2-mem__node")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsPanning(true);
    panStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      viewX: view.x,
      viewY: view.y,
    };
  }, [view.x, view.y]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanning || !panStartRef.current) return;
    const start = panStartRef.current;
    const dx = (e.clientX - start.pointerX) / view.zoom;
    const dy = (e.clientY - start.pointerY) / view.zoom;
    setView((prev) => ({ ...prev, x: start.viewX - dx, y: start.viewY - dy }));
  }, [isPanning, view.zoom]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setIsPanning(false);
    panStartRef.current = null;
  }, []);

  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".v2-mem__node")) return;
    resetView();
  }, [resetView]);

  // Touch pinch (Safari) — keeps deepens parity with trackpad pinch.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let lastScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (e: any) => {
      e.preventDefault();
      const factor = e.scale / lastScale;
      lastScale = e.scale;
      setView((prev) => {
        const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev.zoom * factor));
        return { ...prev, zoom: nextZoom };
      });
    };
    stage.addEventListener("gesturestart", onGestureStart as EventListener);
    stage.addEventListener("gesturechange", onGestureChange as EventListener);
    return () => {
      stage.removeEventListener("gesturestart", onGestureStart as EventListener);
      stage.removeEventListener("gesturechange", onGestureChange as EventListener);
    };
  }, []);

  // viewBox: the visible portion of the canvas in canvas coords.
  // width / height shrink as zoom grows → the SVG renders less area
  // larger. Text labels stay at their natural size.
  const vbW = size.w / view.zoom;
  const vbH = size.h / view.zoom;
  const viewBox = `${view.x} ${view.y} ${vbW} ${vbH}`;
  const isReset = view.x === 0 && view.y === 0 && view.zoom === 1;

  return (
    <div className="v2-mem__constellation">
      <div
        ref={stageRef}
        className="v2-mem__stage"
        data-panning={isPanning}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <svg
          ref={svgRef}
          className="v2-mem__svg"
          width={size.w}
          height={size.h}
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Connection lines (under nodes) */}
          {lines.map((l) => (
            <line
              key={l.key}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              className="v2-mem__line"
            />
          ))}
          {/* Nodes */}
          {entities.map((e) => {
            const p = positions.get(e.id);
            if (!p) return null;
            const isSelected = selectedId === e.id;
            return (
              <g
                key={e.id}
                className="v2-mem__node"
                data-type={e.type}
                data-selected={isSelected}
                transform={`translate(${p.x}, ${p.y})`}
                onClick={() => onSelect(isSelected ? null : e.id)}
              >
                {isSelected && <circle r={p.size + 6} className="v2-mem__node-glow" />}
                <circle r={p.size} className="v2-mem__node-disc" />
                <text y={p.size + 12} textAnchor="middle" className="v2-mem__node-label">
                  {e.name}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Zoom badge + reset (only shown when zoomed/panned away from default) */}
        <div className="v2-mem__viewport-controls" data-visible={!isReset}>
          <span className="v2-mem__zoom-badge">{Math.round(view.zoom * 100)}%</span>
          <button
            type="button"
            className="v2-mem__reset-btn"
            onClick={resetView}
            title="Reset view (or double-click empty space)"
          >
            <Icon icon={Locate} size="sm" />
            Reset
          </button>
        </div>
      </div>
      <DetailPanel
        entity={selectedEntityFromList(allEntities, selectedId)}
        facts={selectedId ? factsBySubject.get(selectedId) ?? [] : []}
        rels={selectedId ? relsByEntity.get(selectedId) ?? [] : []}
        allEntities={allEntities}
        onSelect={onSelect}
      />
    </div>
  );
}

/* ─────────── Explorer tab ─────────── */

function Explorer({
  entities,
  factsBySubject,
  relsByEntity,
  allEntities,
  selectedId,
  onSelect,
  loading,
}: {
  entities: Entity[];
  factsBySubject: Map<string, Fact[]>;
  relsByEntity: Map<string, Relationship[]>;
  allEntities: Entity[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  loading: boolean;
}) {
  if (loading && entities.length === 0) {
    return <div className="v2-mem__empty">Loading memory…</div>;
  }
  if (entities.length === 0) {
    return <div className="v2-mem__empty">No entities match the current filters.</div>;
  }
  return (
    <div className="v2-mem__explorer">
      <div className="v2-mem__grid">
        {entities.map((e) => (
          <EntityCard
            key={e.id}
            entity={e}
            facts={factsBySubject.get(e.id) ?? []}
            rels={relsByEntity.get(e.id) ?? []}
            allEntities={allEntities}
            active={selectedId === e.id}
            onClick={() => onSelect(selectedId === e.id ? null : e.id)}
          />
        ))}
      </div>
      <DetailPanel
        entity={selectedEntityFromList(allEntities, selectedId)}
        facts={selectedId ? factsBySubject.get(selectedId) ?? [] : []}
        rels={selectedId ? relsByEntity.get(selectedId) ?? [] : []}
        allEntities={allEntities}
        onSelect={onSelect}
      />
    </div>
  );
}

function EntityCard({
  entity,
  facts,
  rels,
  allEntities,
  active,
  onClick,
}: {
  entity: Entity;
  facts: Fact[];
  rels: Relationship[];
  allEntities: Entity[];
  active: boolean;
  onClick: () => void;
}) {
  const IconComp = TYPE_ICON[entity.type];
  const previewFacts = facts.slice(0, 3);
  const previewRels = rels.slice(0, 2);
  return (
    <article className="v2-mem__card" data-active={active} onClick={onClick}>
      <div className="v2-mem__card-head">
        <div className="v2-mem__card-icon">
          <Icon icon={IconComp} size="sm" />
        </div>
        <div className="v2-mem__card-id">
          <div className="v2-mem__card-name">{entity.name}</div>
          <div className="v2-mem__card-type">{entity.type}</div>
        </div>
      </div>
      {previewFacts.length > 0 && (
        <ul className="v2-mem__card-facts">
          {previewFacts.map((f) => (
            <li key={f.id}>
              <span className="v2-mem__card-pred">{f.predicate}</span>
              <span className="v2-mem__card-obj">{f.object}</span>
            </li>
          ))}
        </ul>
      )}
      {previewRels.length > 0 && (
        <div className="v2-mem__card-rels">
          {previewRels.map((r) => {
            const otherId = r.from_id === entity.id ? r.to_id : r.from_id;
            const other = allEntities.find((e) => e.id === otherId);
            return (
              <span key={r.id} className="v2-mem__card-rel-chip">
                {r.type} → {other?.name ?? "(unknown)"}
              </span>
            );
          })}
        </div>
      )}
      <div className="v2-mem__card-foot">
        {facts.length} facts · {rels.length} links
        {entity.source && <> · {entity.source}</>}
      </div>
    </article>
  );
}

/* ─────────── Browser tab ─────────── */

function Browser({
  entities,
  factsBySubject,
  relsByEntity,
  allEntities,
  selectedId,
  onSelect,
}: {
  entities: Entity[];
  factsBySubject: Map<string, Fact[]>;
  relsByEntity: Map<string, Relationship[]>;
  allEntities: Entity[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const selected = selectedId ? entities.find((e) => e.id === selectedId) ?? null : null;
  const facts = selectedId ? factsBySubject.get(selectedId) ?? [] : [];
  const rels = selectedId ? relsByEntity.get(selectedId) ?? [] : [];

  return (
    <div className="v2-mem__browser">
      {/* Column 1: entities */}
      <div className="v2-mem__col">
        <div className="v2-mem__col-head">Entities · {entities.length}</div>
        <ul className="v2-mem__col-list">
          {entities.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className="v2-mem__col-row"
                data-active={selectedId === e.id}
                onClick={() => onSelect(e.id)}
              >
                <Icon icon={TYPE_ICON[e.type]} size="sm" />
                <span className="v2-mem__col-row-name">{e.name}</span>
                <span className="v2-mem__col-row-meta">{e.type}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {/* Column 2: facts */}
      <div className="v2-mem__col">
        <div className="v2-mem__col-head">
          Facts {selected && <>· {facts.length}</>}
        </div>
        {!selected ? (
          <div className="v2-mem__col-empty">Pick an entity to see its facts.</div>
        ) : facts.length === 0 ? (
          <div className="v2-mem__col-empty">No facts yet.</div>
        ) : (
          <ul className="v2-mem__col-list">
            {facts.map((f) => (
              <li key={f.id} className="v2-mem__fact">
                <div className="v2-mem__fact-pred">{f.predicate}</div>
                <div className="v2-mem__fact-obj">{f.object}</div>
                <div className="v2-mem__fact-meta">
                  {(f.confidence * 100).toFixed(0)}% confidence
                  {f.source && <> · {f.source}</>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Column 3: relationships */}
      <div className="v2-mem__col">
        <div className="v2-mem__col-head">
          Relationships {selected && <>· {rels.length}</>}
        </div>
        {!selected ? (
          <div className="v2-mem__col-empty">Pick an entity to see its links.</div>
        ) : rels.length === 0 ? (
          <div className="v2-mem__col-empty">No links yet.</div>
        ) : (
          <ul className="v2-mem__col-list">
            {rels.map((r) => {
              const isOutgoing = r.from_id === selected!.id;
              const otherId = isOutgoing ? r.to_id : r.from_id;
              const other = allEntities.find((e) => e.id === otherId);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className="v2-mem__col-row"
                    onClick={() => other && onSelect(other.id)}
                  >
                    <span className="v2-mem__rel-arrow">{isOutgoing ? "→" : "←"}</span>
                    <span className="v2-mem__col-row-name">{other?.name ?? "(unknown)"}</span>
                    <span className="v2-mem__col-row-meta">{r.type}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ─────────── Detail panel (Constellation + Explorer) ─────────── */

function DetailPanel({
  entity,
  facts,
  rels,
  allEntities,
  onSelect,
}: {
  entity: Entity | null;
  facts: Fact[];
  rels: Relationship[];
  allEntities: Entity[];
  onSelect: (id: string | null) => void;
}) {
  const [tab, setTab] = useState<"profile" | "connections">("profile");

  if (!entity) {
    return (
      <aside className="v2-mem__detail v2-mem__detail--empty">
        <Icon icon={Sparkles} size="md" />
        <p>Select an entity to inspect its facts and links.</p>
      </aside>
    );
  }

  const IconComp = TYPE_ICON[entity.type];

  return (
    <aside className="v2-mem__detail">
      <header className="v2-mem__detail-head">
        <div className="v2-mem__detail-icon">
          <Icon icon={IconComp} size="md" />
        </div>
        <div>
          <div className="v2-mem__detail-name">{entity.name}</div>
          <Chip tone="neutral" dot>
            {entity.type}
          </Chip>
        </div>
      </header>

      <div className="v2-mem__detail-tabs" role="tablist">
        <button
          type="button"
          className="v2-mem__detail-tab"
          data-active={tab === "profile"}
          onClick={() => setTab("profile")}
          role="tab"
        >
          Profile · {facts.length}
        </button>
        <button
          type="button"
          className="v2-mem__detail-tab"
          data-active={tab === "connections"}
          onClick={() => setTab("connections")}
          role="tab"
        >
          Connections · {rels.length}
        </button>
      </div>

      <div className="v2-mem__detail-body">
        {tab === "profile" &&
          (facts.length === 0 ? (
            <div className="v2-mem__detail-empty">No facts yet.</div>
          ) : (
            <ul className="v2-mem__detail-facts">
              {facts.map((f) => (
                <li key={f.id} className="v2-mem__fact">
                  <div className="v2-mem__fact-pred">{f.predicate}</div>
                  <div className="v2-mem__fact-obj">{f.object}</div>
                  <div className="v2-mem__fact-meta">
                    {(f.confidence * 100).toFixed(0)}%
                    {f.source && <> · {f.source}</>}
                  </div>
                </li>
              ))}
            </ul>
          ))}
        {tab === "connections" &&
          (rels.length === 0 ? (
            <div className="v2-mem__detail-empty">No connections yet.</div>
          ) : (
            <ul className="v2-mem__detail-rels">
              {rels.map((r) => {
                const isOutgoing = r.from_id === entity.id;
                const otherId = isOutgoing ? r.to_id : r.from_id;
                const other = allEntities.find((e) => e.id === otherId);
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="v2-mem__detail-rel"
                      onClick={() => other && onSelect(other.id)}
                    >
                      <span className="v2-mem__rel-arrow">{isOutgoing ? "→" : "←"}</span>
                      <span className="v2-mem__detail-rel-name">{other?.name ?? "(unknown)"}</span>
                      <span className="v2-mem__detail-rel-type">{r.type}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ))}
      </div>
    </aside>
  );
}

/* ─────────── helpers ─────────── */

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

function selectedEntityFromList(list: Entity[], id: string | null): Entity | null {
  if (!id) return null;
  return list.find((e) => e.id === id) ?? null;
}
