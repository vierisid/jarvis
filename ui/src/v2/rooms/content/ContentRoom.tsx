import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  KanbanSquare,
  List,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Chip, Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import { parseRelativeDate } from "../../../../../src/voice/parse-date";
import {
  CONTENT_STAGES,
  CONTENT_TYPES,
  useContentData,
  type ContentAttachment,
  type ContentItem,
  type ContentStage,
  type ContentStageNote,
  type ContentType,
} from "./useContentData";
import "./ContentRoom.css";

type ViewMode = "kanban" | "list";

const STAGE_LABEL: Record<ContentStage, string> = {
  idea: "Idea",
  research: "Research",
  outline: "Outline",
  draft: "Draft",
  assets: "Assets",
  review: "Review",
  scheduled: "Scheduled",
  published: "Published",
};

const TYPE_LABEL: Record<ContentType, string> = {
  youtube: "YouTube",
  blog: "Blog",
  twitter: "X/Twitter",
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  podcast: "Podcast",
  newsletter: "Newsletter",
  short_form: "Short",
  other: "Other",
};

const TYPE_SHORT: Record<ContentType, string> = {
  youtube: "YT",
  blog: "BL",
  twitter: "X",
  instagram: "IG",
  tiktok: "TT",
  linkedin: "LI",
  podcast: "POD",
  newsletter: "NL",
  short_form: "SF",
  other: "—",
};

const STAGE_TONE: Record<ContentStage, "ok" | "neutral" | "warn" | "accent"> = {
  idea: "neutral",
  research: "neutral",
  outline: "neutral",
  draft: "warn",
  assets: "warn",
  review: "warn",
  scheduled: "ok",
  published: "ok",
};

export type RoomBodyMode = "inline" | "expanded";

export function ContentRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useContentData();
  const [view, setView] = useState<ViewMode>("kanban");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<ContentStage | "all">("all");
  const [typeFilter, setTypeFilter] = useState<ContentType | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const filteredItems = useMemo(() => {
    let list = data.items;
    if (stageFilter !== "all") list = list.filter((i) => i.stage === stageFilter);
    if (typeFilter !== "all") list = list.filter((i) => i.content_type === typeFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.tags.some((t) => t.toLowerCase().includes(q)) ||
          i.content_type.toLowerCase().includes(q),
      );
    }
    return list;
  }, [data.items, search, stageFilter, typeFilter]);

  const filteredByStage = useMemo(() => {
    const map = new Map<ContentStage, ContentItem[]>();
    for (const s of CONTENT_STAGES) map.set(s, []);
    for (const it of filteredItems) map.get(it.stage)?.push(it);
    return map;
  }, [filteredItems]);

  const selected = useMemo(
    () => (selectedId ? data.items.find((i) => i.id === selectedId) ?? null : null),
    [data.items, selectedId],
  );

  // Voice room actions.
  useRoomActions("content", (action, args) => {
    switch (action) {
      case "switch_view": {
        const v = String(args.view);
        if (v === "kanban" || v === "list") {
          setView(v);
          return true;
        }
        return false;
      }
      case "search":
        setSearch(typeof args.query === "string" ? args.query : "");
        return true;
      case "set_filter": {
        const field = String(args.field);
        const value = String(args.value);
        if (field === "stage") {
          if (value === "all" || (CONTENT_STAGES as readonly string[]).includes(value)) {
            setStageFilter(value as ContentStage | "all");
            return true;
          }
        } else if (field === "type") {
          if (value === "all" || (CONTENT_TYPES as readonly string[]).includes(value)) {
            setTypeFilter(value as ContentType | "all");
            return true;
          }
        }
        return false;
      }
      case "select": {
        const name = typeof args.name === "string" ? args.name : "";
        const it = data.findByName(name);
        if (!it) return false;
        setSelectedId(it.id);
        return true;
      }
      case "create_content": {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) return false;
        const ct = (args.type as ContentType) ?? undefined;
        (async () => {
          const r = await data.createContent({ title, content_type: ct });
          if (r.ok) {
            setSelectedId(r.item.id);
            setToast({ text: `Created "${r.item.title}".`, tone: "ok" });
          } else {
            setToast({ text: r.message, tone: "warn" });
          }
        })();
        return true;
      }
      case "advance": {
        const name = typeof args.name === "string" ? args.name : "";
        const it = name ? data.findByName(name) : selected;
        if (!it) return false;
        (async () => {
          const r = await data.advance(it.id);
          setToast({ text: r.ok ? `${it.title}: ${r.message}` : r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      case "regress": {
        const name = typeof args.name === "string" ? args.name : "";
        const it = name ? data.findByName(name) : selected;
        if (!it) return false;
        (async () => {
          const r = await data.regress(it.id);
          setToast({ text: r.ok ? `${it.title}: ${r.message}` : r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      case "schedule": {
        const name = typeof args.name === "string" ? args.name : "";
        const whenStr = typeof args.when === "string" ? args.when : "";
        const it = name ? data.findByName(name) : selected;
        if (!it) return false;
        const parsed = whenStr ? parseRelativeDate(whenStr) : null;
        if (!parsed) {
          setToast({ text: `Couldn't parse "${whenStr}".`, tone: "warn" });
          return true;
        }
        (async () => {
          const r = await data.schedule(it.id, parsed.ts);
          setToast({ text: r.ok ? `${it.title}: ${r.message}` : r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      default:
        return false;
    }
  });

  return (
    <div className={`v2-content v2-content--${mode}`}>
      {/* Stats */}
      <div className="v2-content__stats">
        <StatCard label="Total" value={data.stats.total} sub="all stages" />
        <StatCard
          label="In flight"
          value={data.stats.inFlight}
          sub="idea → review"
          tone={data.stats.inFlight > 0 ? "warn" : "neutral"}
        />
        <StatCard
          label="Scheduled"
          value={data.stats.scheduled}
          sub="awaiting publish"
        />
        <StatCard
          label="Published"
          value={data.stats.published}
          sub="all-time"
          tone="ok"
        />
      </div>

      {/* Toolbar */}
      <div className="v2-content__toolbar">
        <div className="v2-content__search">
          <Icon icon={Search} size="sm" />
          <input
            className="v2-content__search-input"
            type="text"
            placeholder="Search title, tag, type…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search content"
          />
        </div>

        <FilterPills
          label="Stage"
          options={["all", ...CONTENT_STAGES]}
          value={stageFilter}
          onChange={(v) => setStageFilter(v as ContentStage | "all")}
        />

        {mode === "expanded" && (
          <select
            className="v2-content__select"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ContentType | "all")}
            aria-label="Filter by type"
          >
            <option value="all">All types</option>
            {CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        )}

        {mode === "expanded" && (
          <div className="v2-content__view-row" role="tablist" aria-label="View">
            <button
              type="button"
              className="v2-content__view-btn"
              data-active={view === "kanban"}
              onClick={() => setView("kanban")}
              aria-label="Kanban view"
              title="Kanban"
            >
              <Icon icon={KanbanSquare} size="sm" />
            </button>
            <button
              type="button"
              className="v2-content__view-btn"
              data-active={view === "list"}
              onClick={() => setView("list")}
              aria-label="List view"
              title="List"
            >
              <Icon icon={List} size="sm" />
            </button>
          </div>
        )}

        <button
          type="button"
          className="v2-content__refresh"
          onClick={data.refresh}
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon icon={RefreshCw} size="sm" />
        </button>
        <button
          type="button"
          className="v2-content__new-btn"
          onClick={() => setCreateOpen(true)}
        >
          <Icon icon={Plus} size="sm" />
          New
        </button>
      </div>

      {data.error && <div className="v2-content__error">{data.error}</div>}

      {/* Content */}
      {view === "kanban" || mode === "inline" ? (
        <Kanban
          itemsByStage={filteredByStage}
          loading={data.loading}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      ) : (
        <ListView
          items={filteredItems}
          loading={data.loading}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      {/* Detail panel — expanded only */}
      {mode === "expanded" && selected && (
        <DetailPanel
          key={selected.id}
          item={selected}
          onClose={() => setSelectedId(null)}
          onSave={async (patch) => {
            const r = await data.updateContent(selected.id, patch);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onAdvance={async () => {
            const r = await data.advance(selected.id);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onRegress={async () => {
            const r = await data.regress(selected.id);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
          }}
          onDelete={async () => {
            if (!confirm(`Delete "${selected.title}"? This cannot be undone.`)) return;
            const r = await data.deleteContent(selected.id);
            setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
            if (r.ok) setSelectedId(null);
          }}
          listNotes={() => data.listNotes(selected.id)}
          addNote={(stage, note) => data.addNote(selected.id, stage, note)}
          listAttachments={() => data.listAttachments(selected.id)}
          addAttachment={(file) => data.addAttachment(selected.id, file)}
          deleteAttachment={(aid) => data.deleteAttachment(selected.id, aid)}
        />
      )}

      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onCreate={async (input) => {
            const r = await data.createContent(input);
            if (r.ok) {
              setSelectedId(r.item.id);
              setToast({ text: `Created "${r.item.title}".`, tone: "ok" });
              return true;
            }
            setToast({ text: r.message, tone: "warn" });
            return false;
          }}
        />
      )}

      {toast && (
        <div role="status" aria-live="polite" className="v2-content__toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export function ContentRoom() {
  return (
    <RoomShell
      title="Content"
      subtitle="drafts · scheduled · published"
      breadcrumb={["Content"]}
    >
      <ContentRoomBody mode="expanded" />
    </RoomShell>
  );
}

/* ─────────── Subcomponents ─────────── */

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | string;
  sub: string;
  tone?: "neutral" | "ok" | "warn" | "accent";
}) {
  return (
    <div className="v2-content__stat" data-tone={tone ?? "neutral"}>
      <div className="v2-content__stat-label">{label}</div>
      <div className="v2-content__stat-value">{value}</div>
      <div className="v2-content__stat-sub">{sub}</div>
    </div>
  );
}

function FilterPills<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<T>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="v2-content__filter-row" role="tablist" aria-label={`Filter by ${label}`}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className="v2-content__filter-btn"
          data-active={value === opt}
          onClick={() => onChange(opt)}
        >
          {opt.replace(/_/g, " ")}
        </button>
      ))}
    </div>
  );
}

function Kanban({
  itemsByStage,
  loading,
  selectedId,
  onSelect,
}: {
  itemsByStage: Map<ContentStage, ContentItem[]>;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (loading && Array.from(itemsByStage.values()).every((arr) => arr.length === 0)) {
    return <div className="v2-content__empty">Loading…</div>;
  }
  return (
    <div className="v2-content__kanban">
      {CONTENT_STAGES.map((stage) => (
        <Column
          key={stage}
          stage={stage}
          items={itemsByStage.get(stage) ?? []}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function Column({
  stage,
  items,
  selectedId,
  onSelect,
}: {
  stage: ContentStage;
  items: ContentItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <section className="v2-content__col" data-stage={stage}>
      <header className="v2-content__col-head">
        <span className="v2-content__col-label">{STAGE_LABEL[stage]}</span>
        <span className="v2-content__col-count">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <div className="v2-content__col-empty">—</div>
      ) : (
        <ul className="v2-content__col-list">
          {items.map((it) => (
            <li key={it.id}>
              <ContentCard
                item={it}
                active={selectedId === it.id}
                onClick={() => onSelect(selectedId === it.id ? null : it.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ContentCard({
  item,
  active,
  onClick,
}: {
  item: ContentItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <article
      className="v2-content__card"
      data-active={active}
      data-type={item.content_type}
      onClick={onClick}
    >
      <div className="v2-content__card-head">
        <span className="v2-content__type-badge" title={TYPE_LABEL[item.content_type]}>
          {TYPE_SHORT[item.content_type]}
        </span>
        <span className="v2-content__card-title">{item.title}</span>
      </div>
      {item.tags.length > 0 && (
        <div className="v2-content__card-tags">
          {item.tags.slice(0, 3).map((t) => (
            <span key={t} className="v2-content__tag">{t}</span>
          ))}
          {item.tags.length > 3 && (
            <span className="v2-content__tag-more">+{item.tags.length - 3}</span>
          )}
        </div>
      )}
      <div className="v2-content__card-foot">
        <span className="v2-content__card-time">{formatRelative(item.updated_at)}</span>
        {item.scheduled_at && item.stage === "scheduled" && (
          <span className="v2-content__card-sched">
            for {formatShort(item.scheduled_at)}
          </span>
        )}
      </div>
    </article>
  );
}

function ListView({
  items,
  loading,
  selectedId,
  onSelect,
}: {
  items: ContentItem[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (loading && items.length === 0) {
    return <div className="v2-content__empty">Loading…</div>;
  }
  if (items.length === 0) {
    return <div className="v2-content__empty">No content matches the current filters.</div>;
  }
  return (
    <ul className="v2-content__list">
      {items.map((it) => (
        <li
          key={it.id}
          className="v2-content__list-row"
          data-active={selectedId === it.id}
          onClick={() => onSelect(selectedId === it.id ? null : it.id)}
        >
          <span className="v2-content__type-badge" title={TYPE_LABEL[it.content_type]}>
            {TYPE_SHORT[it.content_type]}
          </span>
          <span className="v2-content__list-title">{it.title}</span>
          <Chip tone={STAGE_TONE[it.stage]} dot>
            {STAGE_LABEL[it.stage]}
          </Chip>
          <span className="v2-content__list-time">{formatRelative(it.updated_at)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ─────────── Detail panel ─────────── */

function DetailPanel({
  item,
  onClose,
  onSave,
  onAdvance,
  onRegress,
  onDelete,
  listNotes,
  addNote,
  listAttachments,
  addAttachment,
  deleteAttachment,
}: {
  item: ContentItem;
  onClose: () => void;
  onSave: (patch: Partial<ContentItem>) => void;
  onAdvance: () => void;
  onRegress: () => void;
  onDelete: () => void;
  listNotes: () => Promise<ContentStageNote[]>;
  addNote: (stage: ContentStage, note: string) => Promise<{ ok: boolean; message: string }>;
  listAttachments: () => Promise<ContentAttachment[]>;
  addAttachment: (file: File) => Promise<{ ok: boolean; message: string }>;
  deleteAttachment: (aid: string) => Promise<{ ok: boolean; message: string }>;
}) {
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [tags, setTags] = useState(item.tags.join(", "));
  const [notes, setNotes] = useState<ContentStageNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [attachments, setAttachments] = useState<ContentAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset draft state when the selected item changes (parent uses key prop).
  useEffect(() => {
    setTitle(item.title);
    setBody(item.body);
    setTags(item.tags.join(", "));
  }, [item.id]);

  // Load notes + attachments when item changes.
  useEffect(() => {
    listNotes().then(setNotes).catch(() => setNotes([]));
    listAttachments().then(setAttachments).catch(() => setAttachments([]));
  }, [item.id, listNotes, listAttachments]);

  const dirty =
    title !== item.title ||
    body !== item.body ||
    tags !== item.tags.join(", ");

  const save = useCallback(async () => {
    const patch: Partial<ContentItem> = {};
    if (title !== item.title) patch.title = title;
    if (body !== item.body) patch.body = body;
    const newTags = tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (JSON.stringify(newTags) !== JSON.stringify(item.tags)) patch.tags = newTags;
    if (Object.keys(patch).length === 0) return;
    onSave(patch);
  }, [title, body, tags, item, onSave]);

  const handleAddNote = async () => {
    if (!noteDraft.trim()) return;
    const r = await addNote(item.stage, noteDraft.trim());
    if (r.ok) {
      setNoteDraft("");
      const fresh = await listNotes();
      setNotes(fresh);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const r = await addAttachment(file);
    if (r.ok) {
      const fresh = await listAttachments();
      setAttachments(fresh);
    }
    // Reset so the same file can be re-added if the user picks it again.
    e.target.value = "";
  };

  const handleDeleteAttachment = async (aid: string) => {
    const r = await deleteAttachment(aid);
    if (r.ok) {
      const fresh = await listAttachments();
      setAttachments(fresh);
    }
  };

  const stageIdx = CONTENT_STAGES.indexOf(item.stage);
  const canRegress = stageIdx > 0;
  const canAdvance = stageIdx < CONTENT_STAGES.length - 1;

  return (
    <aside className="v2-content__side">
      <header className="v2-content__side-head">
        <div className="v2-content__side-meta">
          <span className="v2-content__type-badge" title={TYPE_LABEL[item.content_type]}>
            {TYPE_SHORT[item.content_type]}
          </span>
          <Chip tone={STAGE_TONE[item.stage]} dot>
            {STAGE_LABEL[item.stage]}
          </Chip>
        </div>
        <button
          type="button"
          className="v2-content__icon-btn"
          onClick={onClose}
          aria-label="Close detail"
        >
          <Icon icon={X} size="sm" />
        </button>
      </header>

      <div className="v2-content__side-body">
        <input
          type="text"
          className="v2-content__side-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
        />

        <label className="v2-content__field">
          <span className="v2-content__field-label">Tags (comma-separated)</span>
          <input
            type="text"
            className="v2-content__input"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="e.g. q3, launch, demo"
          />
        </label>

        <label className="v2-content__field">
          <span className="v2-content__field-label">Body</span>
          <textarea
            className="v2-content__textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            placeholder="Draft, notes, or full body…"
          />
        </label>

        <div className="v2-content__side-actions">
          <button
            type="button"
            className="v2-content__btn v2-content__btn--secondary"
            onClick={onRegress}
            disabled={!canRegress}
          >
            <Icon icon={ChevronLeft} size="sm" />
            Back
          </button>
          <button
            type="button"
            className="v2-content__btn v2-content__btn--secondary"
            onClick={onAdvance}
            disabled={!canAdvance}
          >
            Advance
            <Icon icon={ChevronRight} size="sm" />
          </button>
          <div className="v2-content__side-actions-spacer" />
          <button
            type="button"
            className="v2-content__btn v2-content__btn--primary"
            onClick={save}
            disabled={!dirty}
          >
            <Icon icon={Save} size="sm" />
            Save
          </button>
        </div>

        {/* Stage notes */}
        <section className="v2-content__side-section">
          <div className="v2-content__side-label">Stage notes</div>
          {notes.length === 0 ? (
            <div className="v2-content__empty-line">No notes yet.</div>
          ) : (
            <ul className="v2-content__notes">
              {notes.map((n) => (
                <li key={n.id} className="v2-content__note">
                  <div className="v2-content__note-meta">
                    <span className="v2-content__note-stage">{STAGE_LABEL[n.stage]}</span>
                    <span className="v2-content__note-time">{formatRelative(n.created_at)}</span>
                  </div>
                  <div className="v2-content__note-text">{n.note}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="v2-content__note-add">
            <input
              type="text"
              className="v2-content__input"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={`Add a note for ${STAGE_LABEL[item.stage]}…`}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddNote();
              }}
            />
            <button
              type="button"
              className="v2-content__btn v2-content__btn--secondary"
              onClick={handleAddNote}
              disabled={!noteDraft.trim()}
            >
              Add
            </button>
          </div>
        </section>

        {/* Attachments */}
        <section className="v2-content__side-section">
          <div className="v2-content__side-label">Attachments</div>
          {attachments.length === 0 ? (
            <div className="v2-content__empty-line">No attachments.</div>
          ) : (
            <ul className="v2-content__attachments">
              {attachments.map((a) => (
                <li key={a.id} className="v2-content__attachment">
                  <Icon icon={Paperclip} size="sm" />
                  <span className="v2-content__attachment-name">{a.filename}</span>
                  <span className="v2-content__attachment-size">{formatBytes(a.size_bytes)}</span>
                  <button
                    type="button"
                    className="v2-content__icon-btn"
                    onClick={() => handleDeleteAttachment(a.id)}
                    aria-label="Remove attachment"
                  >
                    <Icon icon={Trash2} size="sm" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFile}
            style={{ display: "none" }}
          />
          <button
            type="button"
            className="v2-content__btn v2-content__btn--secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon icon={Plus} size="sm" />
            Upload file
          </button>
        </section>

        <button
          type="button"
          className="v2-content__btn v2-content__btn--danger"
          onClick={onDelete}
        >
          <Icon icon={Trash2} size="sm" />
          Delete content
        </button>
      </div>
    </aside>
  );
}

/* ─────────── Create dialog ─────────── */

function CreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    title: string;
    content_type: ContentType;
    stage: ContentStage;
    tags?: string[];
  }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ContentType>("blog");
  const [stage, setStage] = useState<ContentStage>("idea");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const ok = await onCreate({ title: title.trim(), content_type: type, stage });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div className="v2-content__overlay" onClick={() => !busy && onClose()}>
      <div
        className="v2-content__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-content-create-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="v2-content__dialog-head">
          <div>
            <div id="v2-content-create-title" className="v2-content__dialog-title">
              New content
            </div>
            <div className="v2-content__dialog-subtitle">
              Quick create — full edit in the side panel after.
            </div>
          </div>
          <button
            type="button"
            className="v2-content__icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <Icon icon={X} size="sm" />
          </button>
        </div>

        <div className="v2-content__dialog-body">
          <label className="v2-content__field">
            <span className="v2-content__field-label">Title</span>
            <input
              type="text"
              className="v2-content__input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's the piece about?"
              autoFocus
            />
          </label>

          <label className="v2-content__field">
            <span className="v2-content__field-label">Type</span>
            <select
              className="v2-content__input"
              value={type}
              onChange={(e) => setType(e.target.value as ContentType)}
            >
              {CONTENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>

          <label className="v2-content__field">
            <span className="v2-content__field-label">Starting stage</span>
            <div className="v2-content__chip-row">
              {CONTENT_STAGES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="v2-content__chip"
                  data-active={stage === s}
                  onClick={() => setStage(s)}
                >
                  {STAGE_LABEL[s]}
                </button>
              ))}
            </div>
          </label>
        </div>

        <div className="v2-content__dialog-foot">
          <button
            type="button"
            className="v2-content__btn v2-content__btn--secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="v2-content__btn v2-content__btn--primary"
            onClick={submit}
            disabled={busy || !title.trim()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────── helpers ─────────── */

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatShort(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// silence unused-import lints
void FileText;
