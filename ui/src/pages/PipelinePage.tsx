import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useApiData, api } from "../hooks/useApi";
import { PipelineBodyEditor } from "../components/pipeline/PipelineBodyEditor";
import { PipelineStageNotes } from "../components/pipeline/PipelineStageNotes";
import { PipelineAttachments } from "../components/pipeline/PipelineAttachments";
import { PipelineActions } from "../components/pipeline/PipelineActions";
import { ContentCreateModal } from "../components/pipeline/ContentCreateModal";
import type { ContentItem } from "../components/pipeline/PipelineItemCard";
import type { ContentEvent } from "../hooks/useWebSocket";
import "../styles/pipeline.css";

const STAGES = [
  { value: "idea",      label: "Idea",     color: "#A78BFA" },
  { value: "research",  label: "Research", color: "#60A5FA" },
  { value: "outline",   label: "Outline",  color: "#34D399" },
  { value: "draft",     label: "Draft",    color: "#22D3EE" },
  { value: "assets",    label: "Assets",   color: "#FBBF24" },
  { value: "review",    label: "Review",   color: "#F472B6" },
  { value: "scheduled", label: "Sched",    color: "#FF9800" },
  { value: "published", label: "Pub",      color: "#34D399" },
];

const TYPE_LABELS: Record<string, string> = {
  youtube: "YT", blog: "Blog", twitter: "X", instagram: "IG", tiktok: "TT",
  linkedin: "LI", podcast: "Pod", newsletter: "NL", short_form: "Short", other: "Other",
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type Props = {
  contentEvents: ContentEvent[];
  sendMessage: (text: string) => void;
};

export default function PipelinePage({ contentEvents, sendMessage }: Props) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(new Set());
  const lastProcessedRef = useRef(0);

  const { data: items, loading, refetch } = useApiData<ContentItem[]>("/api/content", [refreshKey]);
  const [localItems, setLocalItems] = useState<ContentItem[]>([]);

  useEffect(() => { if (items) setLocalItems(items); }, [items]);

  // Process real-time events
  useEffect(() => {
    if (!contentEvents || contentEvents.length === 0) return;
    const newEvents = contentEvents.filter(e => e.timestamp > lastProcessedRef.current);
    if (newEvents.length === 0) return;
    lastProcessedRef.current = newEvents[newEvents.length - 1]!.timestamp;

    setLocalItems(prev => {
      let updated = [...prev];
      const newUpdatedIds = new Set<string>();
      for (const event of newEvents) {
        const { action, item } = event;
        const idx = updated.findIndex(t => t.id === item.id);
        if (action === "created") { if (idx === -1) { updated.push(item); newUpdatedIds.add(item.id); } }
        else if (action === "updated") { if (idx !== -1) updated[idx] = item; else updated.push(item); newUpdatedIds.add(item.id); }
        else if (action === "deleted") { if (idx !== -1) updated.splice(idx, 1); if (selectedId === item.id) setSelectedId(null); }
      }
      if (newUpdatedIds.size > 0) {
        setRecentlyUpdated(prev => new Set([...prev, ...newUpdatedIds]));
        setTimeout(() => { setRecentlyUpdated(prev => { const next = new Set(prev); for (const id of newUpdatedIds) next.delete(id); return next; }); }, 1500);
      }
      return updated;
    });

    if (newEvents.some(e => e.item.id === selectedId && e.action === "updated")) setRefreshKey(k => k + 1);
  }, [contentEvents, selectedId]);

  // Stage counts
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of STAGES) counts[s.value] = 0;
    for (const item of localItems) counts[item.stage] = (counts[item.stage] || 0) + 1;
    return counts;
  }, [localItems]);

  // Filtered + sorted items
  const filteredItems = useMemo(() => {
    let result = localItems;
    if (stageFilter) result = result.filter(i => i.stage === stageFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.tags.some(t => t.toLowerCase().includes(q)) ||
        i.content_type.toLowerCase().includes(q)
      );
    }
    return [...result].sort((a, b) => {
      if (a.stage === "published" && b.stage !== "published") return 1;
      if (a.stage !== "published" && b.stage === "published") return -1;
      return b.updated_at - a.updated_at;
    });
  }, [localItems, stageFilter, searchQuery]);

  const handleCreated = useCallback(() => { refetch(); }, [refetch]);
  const handleDeleted = useCallback(() => { setSelectedId(null); refetch(); }, [refetch]);
  const handleChanged = useCallback(() => { refetch(); }, [refetch]);

  return (
    <div className="pl-page">
      <div className="pl-atmosphere" />

      {/* Header */}
      <div className="pl-header">
        <span className="pl-header-title">Content Pipeline</span>
        <span className="pl-header-count">{localItems.length}</span>
        <div className="pl-header-spacer" />
        <div className="pl-search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input className="pl-search-input" placeholder="Search content..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
        </div>
        <button className="pl-new-btn" onClick={() => setModalOpen(true)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Content
        </button>
      </div>

      {/* Pipeline bar */}
      <div className="pl-pipeline-bar">
        {STAGES.map((stage, i) => {
          const count = stageCounts[stage.value] || 0;
          const isActive = stageFilter === stage.value;
          return (
            <React.Fragment key={stage.value}>
              {i > 0 && (
                <div className="pl-pipe-connector" style={{
                  background: `linear-gradient(90deg, ${STAGES[i-1]!.color}, ${stage.color})`,
                }} />
              )}
              <div
                className={`pl-pipe-stage${isActive ? " active" : ""}`}
                onClick={() => setStageFilter(isActive ? "" : stage.value)}
              >
                <div className="pl-pipe-node" style={{
                  borderColor: stage.color,
                  color: stage.color,
                  background: `${stage.color}15`,
                  boxShadow: (isActive || count > 0) ? `0 0 10px ${stage.color}40` : "none",
                }}>
                  {count}
                </div>
                <div className="pl-pipe-label" style={{ color: stage.color }}>{stage.label}</div>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Content area */}
      {loading ? (
        <div className="pl-loading">
          <div className="pl-loading-orb" />
          <div className="pl-loading-text">Loading pipeline...</div>
        </div>
      ) : (
        <div className="pl-content-area">
          {/* Card grid */}
          <div className="pl-card-area">
            {filteredItems.length === 0 ? (
              <div className="pl-empty-grid">
                <div className="empty-icon">{stageFilter ? "\u{1F50D}" : "\u{1F4DD}"}</div>
                <p>{stageFilter ? `No ${stageFilter} items` : searchQuery ? "No content matches your search" : "No content yet. Create your first item!"}</p>
              </div>
            ) : (
              <div className="pl-card-grid">
                {filteredItems.map((item, i) => {
                  const stageInfo = STAGES.find(s => s.value === item.stage);
                  const stageColor = stageInfo?.color || "#8B5CF6";
                  return (
                    <div
                      key={item.id}
                      className={`pl-content-card${item.id === selectedId ? " selected" : ""}${recentlyUpdated.has(item.id) ? " just-updated" : ""}`}
                      style={{ animationDelay: `${0.03 + i * 0.03}s` }}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div className="pl-cc-top">
                        <span className="pl-type-tag">{TYPE_LABELS[item.content_type] || item.content_type}</span>
                        <span className="pl-stage-badge" style={{ background: `${stageColor}20`, color: stageColor }}>{item.stage}</span>
                        <span className="pl-cc-time">{timeAgo(item.updated_at)}</span>
                      </div>
                      <div className="pl-cc-title">{item.title}</div>
                      {item.tags.length > 0 && (
                        <div className="pl-cc-tags">
                          {item.tags.slice(0, 3).map(t => <span key={t} className="pl-cc-tag">{t}</span>)}
                          {item.tags.length > 3 && <span className="pl-cc-tag">+{item.tags.length - 3}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Detail panel */}
          <DetailPanel
            itemId={selectedId}
            refreshKey={refreshKey}
            sendMessage={sendMessage}
            onDeleted={handleDeleted}
            onChanged={handleChanged}
          />
        </div>
      )}

      <ContentCreateModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={handleCreated} />
    </div>
  );
}

// ── Detail Panel ──

function DetailPanel({ itemId, refreshKey, sendMessage, onDeleted, onChanged }: {
  itemId: string | null;
  refreshKey: number;
  sendMessage: (text: string) => void;
  onDeleted: () => void;
  onChanged: () => void;
}) {
  const { data: item, refetch: refetchItem } = useApiData<ContentItem>(
    itemId ? `/api/content/${itemId}` : null, [itemId, refreshKey]
  );
  const { data: notes, refetch: refetchNotes } = useApiData<any[]>(
    itemId ? `/api/content/${itemId}/notes` : null, [itemId, refreshKey]
  );
  const { data: attachments, refetch: refetchAttachments } = useApiData<any[]>(
    itemId ? `/api/content/${itemId}/attachments` : null, [itemId, refreshKey]
  );

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const [editingTags, setEditingTags] = useState(false);
  const [tagsValue, setTagsValue] = useState("");

  useEffect(() => {
    if (item) { setTitleValue(item.title); setTagsValue(item.tags.join(", ")); }
  }, [item]);

  const handleBodySave = useCallback(async (body: string) => {
    if (!itemId) return;
    try { await api(`/api/content/${itemId}`, { method: "PATCH", body: JSON.stringify({ body }) }); } catch {}
  }, [itemId]);

  const handleTitleSave = async () => {
    if (!itemId || !titleValue.trim()) return;
    setEditingTitle(false);
    try { await api(`/api/content/${itemId}`, { method: "PATCH", body: JSON.stringify({ title: titleValue.trim() }) }); onChanged(); } catch {}
  };

  const handleTagsSave = async () => {
    if (!itemId) return;
    setEditingTags(false);
    const tags = tagsValue.split(",").map(t => t.trim()).filter(Boolean);
    try { await api(`/api/content/${itemId}`, { method: "PATCH", body: JSON.stringify({ tags }) }); onChanged(); } catch {}
  };

  const handleAdvance = async () => {
    if (!itemId) return;
    try { await api(`/api/content/${itemId}/advance`, { method: "POST" }); refetchItem(); onChanged(); } catch {}
  };
  const handleRegress = async () => {
    if (!itemId) return;
    try { await api(`/api/content/${itemId}/regress`, { method: "POST" }); refetchItem(); onChanged(); } catch {}
  };
  const handleDelete = async () => {
    if (!itemId) return;
    try { await api(`/api/content/${itemId}`, { method: "DELETE" }); onDeleted(); } catch {}
  };

  if (!itemId) {
    return (
      <div className="pl-detail-panel">
        <div className="pl-no-selection">
          <div className="pl-no-selection-icon">{"\u25B6"}</div>
          <span>Select a content item to edit</span>
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="pl-detail-panel">
        <div className="pl-loading">
          <div className="pl-loading-orb" />
          <div className="pl-loading-text">Loading...</div>
        </div>
      </div>
    );
  }

  const stageInfo = STAGES.find(s => s.value === item.stage);
  const stageColor = stageInfo?.color || "#8B5CF6";

  return (
    <div className="pl-detail-panel" key={itemId}>
      {/* Header */}
      <div className="pl-dp-header">
        {editingTitle ? (
          <input
            className="pl-dp-title-input"
            value={titleValue}
            onChange={e => setTitleValue(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={e => e.key === "Enter" && handleTitleSave()}
            autoFocus
          />
        ) : (
          <h1 className="pl-dp-title" onClick={() => setEditingTitle(true)}>{item.title}</h1>
        )}
        <div className="pl-dp-meta">
          <span className="pl-type-tag">{TYPE_LABELS[item.content_type] || item.content_type}</span>
          <span className="pl-stage-badge" style={{ background: `${stageColor}20`, color: stageColor }}>{item.stage}</span>
          <span className="pl-dp-meta-text">by {item.created_by} · {timeAgo(item.updated_at)}</span>
        </div>
        {editingTags ? (
          <input
            className="pl-dp-tags-input"
            value={tagsValue}
            onChange={e => setTagsValue(e.target.value)}
            onBlur={handleTagsSave}
            onKeyDown={e => e.key === "Enter" && handleTagsSave()}
            placeholder="tag1, tag2, tag3"
            autoFocus
          />
        ) : (
          <div className="pl-dp-tags" onClick={() => setEditingTags(true)}>
            {item.tags.length > 0
              ? item.tags.map(t => <span key={t} className="pl-dp-tag">{t}</span>)
              : <span className="pl-dp-tags-hint">Click to add tags</span>
            }
          </div>
        )}
      </div>

      {/* Scrollable content */}
      <div className="pl-dp-content">
        <PipelineBodyEditor body={item.body} stage={item.stage} onSave={handleBodySave} />
        <PipelineActions
          contentId={item.id} stage={item.stage} title={item.title}
          onAdvance={handleAdvance} onRegress={handleRegress} onDelete={handleDelete}
          sendMessage={sendMessage}
        />
        <PipelineStageNotes
          contentId={item.id} currentStage={item.stage}
          notes={notes ?? []} onNoteAdded={refetchNotes}
        />
        <PipelineAttachments
          contentId={item.id} attachments={attachments ?? []}
          onChanged={refetchAttachments}
        />
      </div>
    </div>
  );
}
