import React, { useEffect, useMemo, useState } from "react";
import { Search, Terminal } from "lucide-react";
import { Chip, Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import "./ToolsRoom.css";

type Impact = "read" | "write" | "destructive" | "external";

type Tool = {
  name: string;
  category: string;
  actionCategory: string;
  impact: Impact;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
  }>;
};

const IMPACT_TONE: Record<Impact, "ok" | "neutral" | "warn" | "accent"> = {
  read: "ok",
  write: "neutral",
  external: "warn",
  destructive: "accent",
};

const IMPACT_ORDER: Record<Impact, number> = {
  read: 0,
  write: 1,
  external: 2,
  destructive: 3,
};

type Filter = "all" | Impact;

const FILTER_ORDER: Filter[] = ["all", "read", "write", "external", "destructive"];

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  read: "Read",
  write: "Write",
  external: "External",
  destructive: "Destructive",
};

export type RoomBodyMode = "inline" | "expanded";

/**
 * Tools Room body — works in both inline (RoomWindow card) and expanded
 * (RoomShell overlay) presentations. In inline mode the detail pane is
 * suppressed and clicking a row inflates the row's parameters in-place.
 * In expanded mode, the standard two-pane layout (list left, detail right)
 * is shown.
 */
export function ToolsRoomBody({ mode }: { mode: RoomBodyMode }) {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedName, setSelectedName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tools")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Tool[]) => {
        if (cancelled) return;
        setTools(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load tools");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!tools) return [];
    const q = query.trim().toLowerCase();
    return tools
      .filter((t) => filter === "all" || t.impact === filter)
      .filter(
        (t) =>
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const di = IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact];
        return di !== 0 ? di : a.name.localeCompare(b.name);
      });
  }, [tools, query, filter]);

  // In expanded mode, default to first row when none is selected so the
  // detail pane has content. In inline mode, leave nothing selected so the
  // user explicitly chooses a tool to drill into.
  useEffect(() => {
    if (mode !== "expanded") return;
    if (filtered.length === 0) {
      setSelectedName(null);
      return;
    }
    if (!selectedName || !filtered.some((t) => t.name === selectedName)) {
      setSelectedName(filtered[0]!.name);
    }
  }, [filtered, selectedName, mode]);

  const selected = useMemo(
    () => (selectedName ? filtered.find((t) => t.name === selectedName) ?? null : null),
    [filtered, selectedName],
  );

  // Phase 6.3.5 — voice-driven Room actions.
  useRoomActions("tools", (action, args) => {
    switch (action) {
      case "set_filter": {
        const f = String(args.filter);
        if (f === "all" || f === "read" || f === "write" || f === "external" || f === "destructive") {
          setFilter(f as Filter);
          return true;
        }
        return false;
      }
      case "search":
        setQuery(typeof args.query === "string" ? args.query : "");
        return true;
      case "select": {
        const name = typeof args.name === "string" ? args.name : "";
        if (!name) return false;
        // Fuzzy: prefer exact, then case-insensitive includes.
        const exact = (tools ?? []).find((t) => t.name === name);
        const fuzzy = exact ?? (tools ?? []).find((t) =>
          t.name.toLowerCase().includes(name.toLowerCase()),
        );
        if (!fuzzy) return false;
        setSelectedName(fuzzy.name);
        return true;
      }
      default:
        return false;
    }
  });

  return (
    <div className={`v2-tools v2-tools--${mode}`}>
      <div className="v2-tools__list-pane">
        <div className="v2-tools__filters">
          <div className="v2-tools__search">
            <Icon icon={Search} size="sm" />
            <input
              className="v2-tools__search-input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools…"
              aria-label="Search tools"
            />
          </div>
          <div className="v2-tools__filter-row" role="tablist" aria-label="Filter by impact">
            {FILTER_ORDER.map((f) => (
              <button
                key={f}
                type="button"
                className="v2-tools__filter-btn"
                data-active={filter === f}
                onClick={() => setFilter(f)}
                role="tab"
                aria-selected={filter === f}
              >
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="v2-tools__error">{error}</div>}
        {!error && tools === null && <div className="v2-tools__empty">Loading…</div>}
        {!error && tools !== null && filtered.length === 0 && (
          <div className="v2-tools__empty">
            No tools match {query ? `"${query}"` : "the current filter"}.
          </div>
        )}

        <ul className="v2-tools__list" role="listbox" aria-label="Tools">
          {filtered.map((t) => {
            const active = selectedName === t.name;
            return (
              <li
                key={t.name}
                className="v2-tools__row"
                data-active={active}
                onClick={() => setSelectedName(active ? null : t.name)}
                role="option"
                aria-selected={active}
              >
                <div className="v2-tools__row-icon">
                  <Icon icon={Terminal} size="sm" />
                </div>
                <div className="v2-tools__row-body">
                  <div className="v2-tools__row-head">
                    <span className="v2-tools__row-name">{t.name}</span>
                    <Chip tone={IMPACT_TONE[t.impact]} dot={false}>
                      {t.impact}
                    </Chip>
                  </div>
                  <div className="v2-tools__row-summary">{t.description}</div>
                  <div className="v2-tools__row-meta">
                    <span>{t.category}</span>
                    <span>·</span>
                    <span>{t.actionCategory}</span>
                  </div>
                  {/* Inline mode: show parameters in-row when active */}
                  {mode === "inline" && active && (
                    <div className="v2-tools__row-params">
                      {t.parameters.length === 0 ? (
                        <div className="v2-tools__detail-empty-line">No parameters.</div>
                      ) : (
                        <ul className="v2-tools__params">
                          {t.parameters.map((p) => (
                            <ParamRow key={p.name} param={p} />
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {mode === "expanded" && (
        <div className="v2-tools__detail-pane">
          {selected ? (
            <ToolDetail tool={selected} />
          ) : (
            <div className="v2-tools__detail-empty">
              Select a tool to inspect its parameters.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Phase 6.0 / 6.1.5 — overlay-mode wrapper. Used when the user explicitly
 * expands the inline RoomWindow, opens the Room via direct URL, or
 * Shift+Enter from the palette.
 */
export function ToolsRoom() {
  const [count, setCount] = useState<number | null>(null);

  // Subtitle reflects daemon count once loaded.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tools")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setCount(data.length);
      })
      .catch(() => {/* ignore */});
    return () => {
      cancelled = true;
    };
  }, []);

  const subtitle = count === null
    ? "loading…"
    : `${count} ${count === 1 ? "tool" : "tools"}`;

  return (
    <RoomShell title="Tools" subtitle={subtitle} breadcrumb={["Tools"]}>
      <ToolsRoomBody mode="expanded" />
    </RoomShell>
  );
}

function ToolDetail({ tool }: { tool: Tool }) {
  return (
    <div className="v2-tools__detail">
      <div className="v2-tools__detail-head">
        <div className="v2-tools__detail-title-row">
          <h2 className="v2-tools__detail-title">{tool.name}</h2>
          <Chip tone={IMPACT_TONE[tool.impact]} dot={false}>{tool.impact}</Chip>
        </div>
        <div className="v2-tools__detail-meta">
          <span>{tool.category}</span>
          <span>·</span>
          <span>{tool.actionCategory}</span>
        </div>
      </div>

      <p className="v2-tools__detail-desc">{tool.description}</p>

      <div className="v2-tools__detail-section">
        <div className="v2-tools__detail-section-label">Parameters</div>
        {tool.parameters.length === 0 ? (
          <div className="v2-tools__detail-empty-line">No parameters.</div>
        ) : (
          <ul className="v2-tools__params">
            {tool.parameters.map((p) => (
              <ParamRow key={p.name} param={p} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ParamRow({ param: p }: { param: Tool["parameters"][number] }) {
  return (
    <li className="v2-tools__param">
      <div className="v2-tools__param-head">
        <code className="v2-tools__param-name">{p.name}</code>
        <span className="v2-tools__param-type">{p.type}</span>
        {p.required && <span className="v2-tools__param-req">required</span>}
      </div>
      {p.description && <div className="v2-tools__param-desc">{p.description}</div>}
    </li>
  );
}
