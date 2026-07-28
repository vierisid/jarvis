import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Paperclip, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { confirmDialog } from "../../ui/ConfirmDialog";
import { Icon } from "../../ui";
import { Tabs, StatusChip, Select, EmptyState, Toast, Skeleton, type Tone } from "../../ui/roomkit";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import { parseRelativeDate } from "../../../../../src/voice/parse-date";
import {
  useContentData, type ContentItem, type ContentStage, type ContentType, type ContentStageNote, type ContentAttachment,
} from "./useContentData";
import "./ContentRoom.css";

const CONTENT_STAGES: ContentStage[] = ["idea", "research", "outline", "draft", "assets", "review", "scheduled", "published"];
const CONTENT_TYPES: ContentType[] = ["youtube", "blog", "twitter", "instagram", "tiktok", "linkedin", "podcast", "newsletter", "short_form", "other"];

const STAGE_LABEL: Record<ContentStage, string> = { idea: "Idea", research: "Research", outline: "Outline", draft: "Draft", assets: "Assets", review: "Review", scheduled: "Scheduled", published: "Published" };
const TYPE_LABEL: Record<ContentType, string> = { youtube: "YouTube", blog: "Blog", twitter: "X/Twitter", instagram: "Instagram", tiktok: "TikTok", linkedin: "LinkedIn", podcast: "Podcast", newsletter: "Newsletter", short_form: "Short", other: "Other" };
const TYPE_SHORT: Record<ContentType, string> = { youtube: "YT", blog: "BL", twitter: "X", instagram: "IG", tiktok: "TT", linkedin: "LI", podcast: "POD", newsletter: "NL", short_form: "SF", other: "—" };

// Stage tone remap (content §02): idea/research/outline neutral · draft+assets
// blue (agents work) · review amber (your gate) · scheduled+published green.
const STAGE_TONE: Record<ContentStage, Tone> = { idea: "mut", research: "mut", outline: "mut", draft: "run", assets: "run", review: "hold", scheduled: "ok", published: "ok" };

export type RoomBodyMode = "inline" | "expanded";

export function ContentRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useContentData();
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<ContentStage | "all">("all");
  const [typeFilter, setTypeFilter] = useState<ContentType | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 4000); return () => window.clearTimeout(id); }, [toast]);

  const match = useCallback((it: ContentItem) => {
    if (stageFilter !== "all" && it.stage !== stageFilter) return false;
    if (typeFilter !== "all" && it.content_type !== typeFilter) return false;
    const q = search.trim().toLowerCase();
    if (q && !(it.title.toLowerCase().includes(q) || it.content_type.includes(q) || it.tags.some((t) => t.toLowerCase().includes(q)))) return false;
    return true;
  }, [stageFilter, typeFilter, search]);

  const byStage = useMemo(() => {
    const m = new Map<ContentStage, ContentItem[]>();
    for (const s of CONTENT_STAGES) m.set(s, (data.itemsByStage.get(s) ?? []).filter(match));
    return m;
  }, [data.itemsByStage, match]);

  const listItems = useMemo(() => data.items.filter(match).sort((a, b) => b.updated_at - a.updated_at), [data.items, match]);
  const selected = useMemo(() => data.items.find((i) => i.id === selectedId) ?? null, [data.items, selectedId]);

  useRoomActions("content", (action, args) => {
    switch (action) {
      case "switch_view": { const v = String(args.view); if (v === "kanban" || v === "list") { setView(v); return true; } return false; }
      case "search": setSearch(typeof args.query === "string" ? args.query : ""); return true;
      case "set_filter": {
        const field = String(args.field); const value = String(args.value);
        if (field === "stage") { if (value === "all" || CONTENT_STAGES.includes(value as ContentStage)) { setStageFilter(value as ContentStage | "all"); return true; } }
        if (field === "type") { if (value === "all" || CONTENT_TYPES.includes(value as ContentType)) { setTypeFilter(value as ContentType | "all"); return true; } }
        return false;
      }
      case "select": { const it = data.findByName(typeof args.name === "string" ? args.name : ""); if (!it) return false; setSelectedId(it.id); return true; }
      case "create_content": {
        const title = typeof args.title === "string" ? args.title.trim() : ""; if (!title) return false;
        (async () => { const r = await data.createContent({ title, content_type: (args.type as ContentType) ?? undefined }); if (r.ok) setSelectedId(r.item.id); setToast({ text: r.ok ? `Created "${title}"` : r.message, tone: r.ok ? "ok" : "warn" }); })();
        return true;
      }
      case "advance": case "regress": {
        const it = (typeof args.name === "string" && args.name ? data.findByName(args.name) : null) ?? selected; if (!it) return false;
        (async () => { const r = await (action === "advance" ? data.advance(it.id) : data.regress(it.id)); setToast({ text: r.message, tone: r.ok ? "ok" : "warn" }); })();
        return true;
      }
      case "schedule": {
        const it = (typeof args.name === "string" && args.name ? data.findByName(args.name) : null) ?? selected; if (!it) return false;
        const parsed = typeof args.when === "string" ? parseRelativeDate(args.when) : null;
        if (!parsed) { setToast({ text: "Couldn't parse that date.", tone: "warn" }); return true; }
        (async () => { const r = await data.schedule(it.id, parsed.ts); setToast({ text: r.message, tone: r.ok ? "ok" : "warn" }); })();
        return true;
      }
      default: return false;
    }
  });

  const toastFrom = (r: { ok: boolean; message: string }) => setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
  const kanban = view === "kanban" || mode === "inline";

  return (
    <div className="rk-content">
      <div className="rk-content__tool">
        <span className="rk-content__title">Content</span>
        {mode === "expanded" && <Tabs tabs={[{ key: "kanban", label: "Kanban" }, { key: "list", label: "List" }]} active={view} onChange={(k) => setView(k as "kanban" | "list")} />}
        {mode === "expanded" && (
          <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as ContentType | "all")}>
            <option value="all">all types</option>
            {CONTENT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </Select>
        )}
        <div className="rk-content__search"><Icon icon={Search} size="sm" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search title, tag, type…" aria-label="Search content" /></div>
        <button className="rk-content__icbtn" onClick={data.refresh} aria-label="Refresh"><Icon icon={RefreshCw} size="sm" /></button>
        <button className="rk-content__new" onClick={() => setCreateOpen(true)}>New content</button>
      </div>

      <div className="rk-content__stats">
        <Stat k="total" n={data.stats.total} sub="all stages" />
        <Stat k="in flight" n={data.stats.inFlight} sub="idea → review" tone="blue" />
        <Stat k="scheduled" n={data.stats.scheduled} sub="awaiting publish" />
        <Stat k="published" n={data.stats.published} sub="all-time" tone="green" />
      </div>

      <div className="rk-content__body">
        {data.error ? (
          <div className="rk-content__msg">{data.error}</div>
        ) : data.loading && data.items.length === 0 ? (
          <div style={{ padding: 22, flex: 1 }}><Skeleton lines={6} /></div>
        ) : kanban ? (
          <div className="rk-content__board">
            {CONTENT_STAGES.map((stage) => {
              const items = byStage.get(stage) ?? [];
              return (
                <div className="rk-content__col" key={stage}>
                  <div className="rk-content__colh"><span className="dot" style={{ background: TONE_HUE[STAGE_TONE[stage]] }} />{STAGE_LABEL[stage]}<span className="c">{items.length}</span></div>
                  <div className="rk-content__col-scroll">
                    {items.length === 0 ? <div className="rk-content__col-empty">—</div> : items.map((it) => <ContentCard key={it.id} item={it} selected={selectedId === it.id} onClick={() => setSelectedId(selectedId === it.id ? null : it.id)} />)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rk-content__list">
            {listItems.length === 0 ? (
              <div style={{ padding: 22 }}><EmptyState title="Nothing here yet">Describe a piece to Jarvis or press <b>New content</b> to start the pipeline.</EmptyState></div>
            ) : listItems.map((it) => (
              <button key={it.id} className={`rk-content__row${selectedId === it.id ? " rk-content__row--sel" : ""}`} onClick={() => setSelectedId(selectedId === it.id ? null : it.id)}>
                <span className="rk-content__tbadge" title={TYPE_LABEL[it.content_type]}>{TYPE_SHORT[it.content_type]}</span>
                <span className="rk-content__row-title">{it.title}</span>
                <StatusChip tone={STAGE_TONE[it.stage]} dot>{STAGE_LABEL[it.stage]}</StatusChip>
                <span className="rk-content__row-upd">{formatRelative(it.updated_at)}</span>
              </button>
            ))}
          </div>
        )}

        {mode === "expanded" && selected && (
          <DetailPanel
            key={selected.id}
            item={selected}
            onClose={() => setSelectedId(null)}
            onSave={async (patch) => toastFrom(await data.updateContent(selected.id, patch))}
            onAdvance={async () => toastFrom(await data.advance(selected.id))}
            onRegress={async () => toastFrom(await data.regress(selected.id))}
            onDelete={async () => { if (!await confirmDialog("Delete this content?")) return; const r = await data.deleteContent(selected.id); toastFrom(r); if (r.ok) setSelectedId(null); }}
            listNotes={() => data.listNotes(selected.id)}
            addNote={(stage, note) => data.addNote(selected.id, stage, note)}
            listAttachments={() => data.listAttachments(selected.id)}
            addAttachment={(file) => data.addAttachment(selected.id, file)}
            deleteAttachment={(aid) => data.deleteAttachment(selected.id, aid)}
          />
        )}
      </div>

      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onCreate={async (input) => { const r = await data.createContent(input); if (r.ok) { setSelectedId(r.item.id); setToast({ text: `Created "${input.title}"`, tone: "ok" }); return true; } setToast({ text: r.message, tone: "warn" }); return false; }}
        />
      )}

      {toast && <div className="rk-content__toast"><Toast tone={toast.tone === "ok" ? "ok" : "hold"}>{toast.text}</Toast></div>}
    </div>
  );
}

export function ContentRoom() {
  return (
    <RoomShell title="Content" subtitle="drafts · scheduled · published" breadcrumb={["Content"]}>
      <ContentRoomBody mode="expanded" />
    </RoomShell>
  );
}

const TONE_HUE: Record<Tone, string> = { run: "var(--speak)", ok: "var(--ok)", hold: "var(--hold)", fail: "var(--listen)", mut: "var(--faint)" };

function Stat({ k, n, sub, tone }: { k: string; n: number; sub: string; tone?: "blue" | "green" }) {
  return (
    <div className="rk-content__stat">
      <div className="rk-content__stat-k">{k}</div>
      <div className={`rk-content__stat-n${tone ? ` rk-content__stat-n--${tone}` : ""}`}>{n}</div>
      <div className="rk-content__stat-sub">{sub}</div>
    </div>
  );
}

function ContentCard({ item, selected, onClick }: { item: ContentItem; selected: boolean; onClick: () => void }) {
  return (
    <button className={`rk-content__card${selected ? " rk-content__card--sel" : ""}`} onClick={onClick}>
      <span className="rk-content__card-head"><span className="rk-content__tbadge" title={TYPE_LABEL[item.content_type]}>{TYPE_SHORT[item.content_type]}</span></span>
      <span className="rk-content__card-title">{item.title}</span>
      <span className="rk-content__card-foot">
        {item.tags.slice(0, 2).map((t) => <span key={t}>#{t}</span>)}
        <span style={{ marginLeft: "auto" }}>{formatRelative(item.updated_at)}</span>
        {item.scheduled_at != null && <span className="sched">for {new Date(item.scheduled_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
      </span>
    </button>
  );
}

function DetailPanel({ item, onClose, onSave, onAdvance, onRegress, onDelete, listNotes, addNote, listAttachments, addAttachment, deleteAttachment }: {
  item: ContentItem; onClose: () => void; onSave: (patch: Partial<ContentItem>) => void; onAdvance: () => void; onRegress: () => void; onDelete: () => void;
  listNotes: () => Promise<ContentStageNote[]>; addNote: (stage: ContentStage, note: string) => Promise<{ ok: boolean; message: string }>;
  listAttachments: () => Promise<ContentAttachment[]>; addAttachment: (file: File) => Promise<{ ok: boolean; message: string }>; deleteAttachment: (aid: string) => Promise<{ ok: boolean; message: string }>;
}) {
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [tags, setTags] = useState(item.tags.join(", "));
  const [notes, setNotes] = useState<ContentStageNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [attachments, setAttachments] = useState<ContentAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTitle(item.title); setBody(item.body); setTags(item.tags.join(", ")); }, [item.id]);
  useEffect(() => { listNotes().then(setNotes).catch(() => setNotes([])); listAttachments().then(setAttachments).catch(() => setAttachments([])); }, [item.id, listNotes, listAttachments]);

  const dirty = title !== item.title || body !== item.body || tags !== item.tags.join(", ");
  const save = useCallback(() => {
    const patch: Partial<ContentItem> = {};
    if (title !== item.title) patch.title = title;
    if (body !== item.body) patch.body = body;
    const newTags = tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (JSON.stringify(newTags) !== JSON.stringify(item.tags)) patch.tags = newTags;
    if (Object.keys(patch).length) onSave(patch);
  }, [title, body, tags, item, onSave]);

  const handleAddNote = async () => { if (!noteDraft.trim()) return; const r = await addNote(item.stage, noteDraft.trim()); if (r.ok) { setNoteDraft(""); setNotes(await listNotes()); } };
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (!file) return; const r = await addAttachment(file); if (r.ok) setAttachments(await listAttachments()); e.target.value = ""; };
  const handleDelAtt = async (aid: string) => { const r = await deleteAttachment(aid); if (r.ok) setAttachments(await listAttachments()); };

  const idx = CONTENT_STAGES.indexOf(item.stage);

  return (
    <aside className="rk-content__side">
      <header className="rk-content__side-head">
        <span className="rk-content__tbadge" title={TYPE_LABEL[item.content_type]}>{TYPE_SHORT[item.content_type]}</span>
        <StatusChip tone={STAGE_TONE[item.stage]} dot>{STAGE_LABEL[item.stage]}</StatusChip>
        <span className="rk-content__spacer" />
        <button className="rk-content__icbtn" onClick={onClose} aria-label="Close"><Icon icon={X} size="sm" /></button>
      </header>
      <div className="rk-content__side-body">
        <input className="rk-content__title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        <div>
          <div className="rk-content__field-lab">tags (comma-separated)</div>
          <input className="rk-content__input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. q3, launch, demo" />
        </div>
        <div>
          <div className="rk-content__field-lab">body</div>
          <textarea className="rk-content__textarea" value={body} onChange={(e) => setBody(e.target.value)} rows={7} placeholder="Draft, notes, or full body…" />
        </div>
        <div className="rk-content__row-acts">
          <button className="rk-content__sbtn" onClick={onRegress} disabled={idx <= 0}><Icon icon={ChevronLeft} size="sm" /> Back</button>
          <button className="rk-content__sbtn rk-content__sbtn--pri" onClick={onAdvance} disabled={idx >= CONTENT_STAGES.length - 1}>Advance <Icon icon={ChevronRight} size="sm" /></button>
          <span className="rk-content__spacer" />
          <button className="rk-content__sbtn" onClick={save} disabled={!dirty}><Icon icon={Save} size="sm" /> Save</button>
        </div>

        <div>
          <div className="rk-content__section-lab">stage notes</div>
          {notes.length === 0 ? <div className="rk-content__empty-line" style={{ marginTop: 6 }}>No notes yet.</div> : (
            <ul className="rk-content__notes">
              {notes.map((n) => (
                <li className="rk-content__note" key={n.id}>
                  <div className="rk-content__note-meta"><span><b>{STAGE_LABEL[n.stage]}</b></span><span style={{ marginLeft: "auto" }}>{formatRelative(n.created_at)}</span></div>
                  <div className="rk-content__note-text">{n.note}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="rk-content__note-add">
            <input className="rk-content__input" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder={`Add a note for ${STAGE_LABEL[item.stage]}…`} onKeyDown={(e) => { if (e.key === "Enter") handleAddNote(); }} />
            <button className="rk-content__sbtn" onClick={handleAddNote} disabled={!noteDraft.trim()}>Add</button>
          </div>
        </div>

        <div>
          <div className="rk-content__section-lab">attachments</div>
          {attachments.length === 0 ? <div className="rk-content__empty-line" style={{ marginTop: 6 }}>No attachments.</div> : (
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
              {attachments.map((a) => (
                <li className="rk-content__att" key={a.id}>
                  <Icon icon={Paperclip} size="sm" />
                  <span className="rk-content__att-name">{a.filename}</span>
                  <span className="rk-content__att-size">{formatBytes(a.size_bytes)}</span>
                  <button className="rk-content__icbtn" onClick={() => handleDelAtt(a.id)} aria-label="Remove"><Icon icon={Trash2} size="sm" /></button>
                </li>
              ))}
            </ul>
          )}
          <input ref={fileInputRef} type="file" onChange={handleFile} style={{ display: "none" }} />
          <button className="rk-content__sbtn" style={{ marginTop: 8 }} onClick={() => fileInputRef.current?.click()}><Icon icon={Plus} size="sm" /> Upload file</button>
        </div>

        <button className="rk-content__sbtn rk-content__sbtn--danger" onClick={onDelete}><Icon icon={Trash2} size="sm" /> Delete content</button>
      </div>
    </aside>
  );
}

function CreateDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (input: { title: string; content_type: ContentType; stage: ContentStage }) => Promise<boolean> }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ContentType>("blog");
  const [stage, setStage] = useState<ContentStage>("idea");
  const [busy, setBusy] = useState(false);
  const submit = async () => { if (!title.trim()) return; setBusy(true); const ok = await onCreate({ title: title.trim(), content_type: type, stage }); setBusy(false); if (ok) onClose(); };
  return (
    <div className="rk-content__overlay" onClick={() => !busy && onClose()}>
      <div className="rk-content__dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="rk-content__dialog-head"><div className="rk-content__dialog-title">New content</div></div>
        <div className="rk-content__dialog-body">
          <div><div className="rk-content__field-lab">title</div><input className="rk-content__input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's the piece?" autoFocus /></div>
          <div><div className="rk-content__field-lab">format</div>
            <Select value={type} onChange={(e) => setType(e.target.value as ContentType)}>{CONTENT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</Select>
          </div>
          <div><div className="rk-content__field-lab">starting stage</div>
            <div className="rk-content__chiprow">{CONTENT_STAGES.slice(0, 6).map((s) => <button key={s} className={`rk-content__sbtn${stage === s ? " rk-content__sbtn--pri" : ""}`} onClick={() => setStage(s)}>{STAGE_LABEL[s]}</button>)}</div>
          </div>
        </div>
        <div className="rk-content__dialog-acts">
          <button className="rk-content__sbtn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="rk-content__sbtn rk-content__sbtn--pri" onClick={submit} disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function formatRelative(ts: number): string {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
