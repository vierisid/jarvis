import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  BookMarked,
  Calendar,
  CheckSquare,
  Code2,
  Cog,
  CornerDownLeft,
  Eye,
  FileText,
  Search,
  Shield,
  Target,
  Terminal,
  UserCircle2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Icon, KBD } from "../ui";
import "./CommandPalette.css";
import {
  ROOM_NAV_ENTRIES,
  type PaletteNavEntry,
  type PaletteResult,
  type PaletteResultType,
} from "./types";
import { usePaletteRecent } from "./usePaletteRecent";
import { usePaletteSearch } from "./usePaletteSearch";

const TYPE_ICON: Record<PaletteResultType, LucideIcon> = {
  workflow: Workflow,
  memory: BookMarked,
  tool: Terminal,
  agent: UserCircle2,
  authority: Shield,
  log: Eye,
};

// Per-Room icon for the palette's "Rooms" group. The 6 search-result
// types above only cover the original Phase 6.1–6.6 rooms — palette nav
// entries also include the Phase 6.7 rooms (calendar / goals / tasks /
// content / workspaces / settings), so we map each nav key directly to
// its own Lucide glyph rather than collapsing them through a 6-type
// switch (which used to fall back to Terminal for all of them).
const NAV_ICON: Record<PaletteNavEntry["key"], LucideIcon> = {
  workflows: Workflow,
  memory: BookMarked,
  tools: Terminal,
  agents: UserCircle2,
  authority: Shield,
  logs: Eye,
  calendar: Calendar,
  goals: Target,
  tasks: CheckSquare,
  content: FileText,
  workspaces: Code2,
  usage: BarChart3,
  settings: Cog,
};

const TYPE_LABEL: Record<PaletteResultType, string> = {
  workflow: "Workflow",
  memory: "Memory",
  tool: "Tool",
  agent: "Agent",
  authority: "Authority",
  log: "Log",
};

export interface CommandPaletteProps {
  open: boolean;
  enabled: boolean;
  onClose: () => void;
  /**
   * User picked a specific object → caller should inject it as an
   * `<InlineCard>` ThreadItem. `openInRoom=true` is Phase 6's
   * Shift+Enter affordance (stub for now — the caller should treat as Focus).
   */
  onPickObject: (result: PaletteResult, openInRoom: boolean) => void;
  /**
   * User picked a Room navigation entry → caller should open that Room.
   * `openInRoom` mirrors the object-pick semantics: when true (Shift+Enter),
   * skip the preview-card injection and open the fullscreen Room directly.
   */
  onPickRoom: (entry: PaletteNavEntry, openInRoom: boolean) => void;
}

/**
 * ⌘K / Ctrl+K palette. Modal overlay, focus-trapped (input always focused),
 * Esc closes, ↑↓ moves selection, Enter selects, Shift+Enter "open in Room".
 *
 * Result list structure (top to bottom):
 *   1. Empty query → matching Room nav entries + Recent objects (LRU 5)
 *   2. Non-empty query → matching Room nav entries + matching objects from
 *      the daemon aggregator (re-ranked client-side via Fuse)
 *
 * Selecting any object emits `onPickObject`; selecting any Room nav entry
 * emits `onPickRoom`. The caller decides what each means in the shell.
 */
export function CommandPalette({
  open,
  enabled,
  onClose,
  onPickObject,
  onPickRoom,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { results: objectResults, loading } = usePaletteSearch(query, { enabled: open && enabled });
  const { recent, remember } = usePaletteRecent({ enabled });

  // Filter Room nav entries client-side. Always keep all 10 visible when
  // the query is empty — the panel doubles as a "go anywhere" affordance.
  const navEntries: PaletteNavEntry[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ROOM_NAV_ENTRIES;
    return ROOM_NAV_ENTRIES.filter(
      (e) => e.label.toLowerCase().includes(q) || e.hint.toLowerCase().includes(q) || e.key.includes(q),
    );
  }, [query]);

  // Recent objects only show on empty query.
  const recentResults: PaletteResult[] = useMemo(() => {
    if (query.trim()) return [];
    return recent;
  }, [query, recent]);

  // Reset query and active index every time the palette opens; focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Esc closes; ignore other keys at the document level (the input handles them).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Flat selection model: nav entries first, then recent, then live results.
  const flatItems = useMemo(() => {
    const items: Array<
      | { kind: "nav"; entry: PaletteNavEntry }
      | { kind: "object"; result: PaletteResult; section: "recent" | "results" }
    > = [];
    for (const entry of navEntries) items.push({ kind: "nav", entry });
    for (const r of recentResults) items.push({ kind: "object", result: r, section: "recent" });
    for (const r of objectResults) items.push({ kind: "object", result: r, section: "results" });
    return items;
  }, [navEntries, recentResults, objectResults]);

  // Clamp activeIdx whenever results change.
  useEffect(() => {
    setActiveIdx((idx) => Math.min(idx, Math.max(0, flatItems.length - 1)));
  }, [flatItems.length]);

  const pick = useCallback(
    (idx: number, openInRoom: boolean) => {
      const item = flatItems[idx];
      if (!item) return;
      if (item.kind === "nav") {
        onPickRoom(item.entry, openInRoom);
        onClose();
        return;
      }
      // object
      remember(item.result);
      onPickObject(item.result, openInRoom);
      onClose();
    },
    [flatItems, onPickObject, onPickRoom, onClose, remember],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(activeIdx, e.shiftKey);
    }
  };

  // Scroll the active row into view when keyboard navigates past the viewport.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  if (!open) return null;

  return (
    <div className="v2-palette__scrim" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="v2-palette" onClick={(e) => e.stopPropagation()}>
        <div className="v2-palette__head">
          <Icon icon={Search} size="sm" />
          <input
            ref={inputRef}
            className="v2-palette__input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search workflows, memory, tools, agents, authority, logs…"
            aria-label="Palette search"
          />
          <KBD>Esc</KBD>
        </div>

        <div className="v2-palette__list" ref={listRef}>
          {flatItems.length === 0 && !loading && (
            <div className="v2-palette__empty">
              Nothing matches &ldquo;{query}&rdquo;. Try a different word.
            </div>
          )}

          {/* Rooms group */}
          {navEntries.length > 0 && (
            <Group label="Rooms">
              {navEntries.map((entry, i) => {
                const idx = i;
                return (
                  <Row
                    key={`nav-${entry.key}`}
                    idx={idx}
                    active={activeIdx === idx}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={(e) => pick(idx, e.shiftKey)}
                    icon={NAV_ICON[entry.key]}
                    title={entry.label}
                    hint={entry.hint}
                    typeLabel="Open Room"
                  />
                );
              })}
            </Group>
          )}

          {/* Recent group (only on empty query) */}
          {recentResults.length > 0 && (
            <Group label="Recent">
              {recentResults.map((r, i) => {
                const idx = navEntries.length + i;
                return (
                  <ResultRow
                    key={`recent-${r.type}-${r.id}`}
                    idx={idx}
                    active={activeIdx === idx}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={(e) => pick(idx, e.shiftKey)}
                    result={r}
                  />
                );
              })}
            </Group>
          )}

          {/* Live results group */}
          {objectResults.length > 0 && (
            <Group label={query.trim() ? "Results" : "Suggested"}>
              {objectResults.map((r, i) => {
                const idx = navEntries.length + recentResults.length + i;
                return (
                  <ResultRow
                    key={`obj-${r.type}-${r.id}-${i}`}
                    idx={idx}
                    active={activeIdx === idx}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={(e) => pick(idx, e.shiftKey)}
                    result={r}
                  />
                );
              })}
            </Group>
          )}
        </div>

        <div className="v2-palette__foot">
          <span className="v2-palette__hint">
            <KBD>↑</KBD>
            <KBD>↓</KBD> navigate
          </span>
          <span className="v2-palette__hint">
            <KBD>↵</KBD> insert as card
          </span>
          <span className="v2-palette__hint">
            <KBD>⇧↵</KBD> open Room
          </span>
          <span className="v2-palette__hint v2-palette__hint--right">
            <KBD>Esc</KBD> close
          </span>
        </div>
      </div>

      {/* Click-outside closes */}
      <button
        type="button"
        className="v2-palette__scrim-catcher"
        onClick={onClose}
        aria-label="Close palette"
      />
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="v2-palette__group">
      <div className="v2-palette__group-label">{label}</div>
      <div className="v2-palette__group-rows">{children}</div>
    </div>
  );
}

function Row({
  idx,
  active,
  onMouseEnter,
  onClick,
  icon,
  title,
  hint,
  typeLabel,
}: {
  idx: number;
  active: boolean;
  onMouseEnter: () => void;
  onClick: (e: React.MouseEvent) => void;
  icon: LucideIcon;
  title: string;
  hint?: string;
  typeLabel?: string;
}) {
  return (
    <div
      data-row={idx}
      className={`v2-palette__row ${active ? "v2-palette__row--active" : ""}`}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      role="option"
      aria-selected={active}
    >
      <div className="v2-palette__row-icon">
        <Icon icon={icon} size="md" />
      </div>
      <div className="v2-palette__row-body">
        <div className="v2-palette__row-title">{title}</div>
        {hint && <div className="v2-palette__row-hint">{hint}</div>}
      </div>
      {typeLabel && <span className="v2-palette__row-type">{typeLabel}</span>}
      <span className="v2-palette__row-enter">
        <Icon icon={CornerDownLeft} size="sm" />
      </span>
    </div>
  );
}

function ResultRow({
  idx,
  active,
  onMouseEnter,
  onClick,
  result,
}: {
  idx: number;
  active: boolean;
  onMouseEnter: () => void;
  onClick: (e: React.MouseEvent) => void;
  result: PaletteResult;
}) {
  const I = TYPE_ICON[result.type];
  return (
    <Row
      idx={idx}
      active={active}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      icon={I}
      title={result.title}
      hint={result.summary ?? result.meta}
      typeLabel={TYPE_LABEL[result.type]}
    />
  );
}

function mapNavToType(key: PaletteNavEntry["key"]): PaletteResultType {
  switch (key) {
    case "workflows":
      return "workflow";
    case "memory":
      return "memory";
    case "tools":
      return "tool";
    case "agents":
      return "agent";
    case "authority":
      return "authority";
    case "logs":
      return "log";
    default:
      // Calendar/Goals/Sites/Settings have no first-class object icon yet —
      // reuse `tool` as a neutral default until Phase 6 adds dedicated glyphs.
      return "tool";
  }
}
